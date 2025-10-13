// src/services/notificationService.js
const admin = require('firebase-admin');
const userDb = require('../db/users');
const redisClient = require('../db/redis');

// Initialize Firebase Admin (you'll need to add your service account key)
const serviceAccount = require('../config/firebase-service-account.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

class NotificationService {
  /**
   * Create a driver queue for a ride request
   */
  async createDriverQueue(requestId, nearbyDrivers) {
    const driverQueueKey = `ride:request:${requestId}:queue`;
    const driverIds = nearbyDrivers.map(d => d.driverId);
    
    if (driverIds.length > 0) {
      // Push all driver IDs to the queue
      await redisClient.sendCommand(['RPUSH', driverQueueKey, ...driverIds]);
      // Set TTL for 10 minutes
      await redisClient.sendCommand(['EXPIRE', driverQueueKey, '600']);
      
      // Set current driver index
      await redisClient.sendCommand(['SET', `ride:request:${requestId}:current_driver`, '0']);
      await redisClient.sendCommand(['EXPIRE', `ride:request:${requestId}:current_driver`, '600']);
    }
    
    return driverIds.length;
  }

  /**
   * Process the driver queue - notify drivers one by one
   */
  async processDriverQueue(requestId, rideDetails) {
    const driverQueueKey = `ride:request:${requestId}:queue`;
    const currentDriverKey = `ride:request:${requestId}:current_driver`;
    const statusKey = `ride:request:${requestId}:status`;
    
    // Check if request is still pending
    const status = await redisClient.sendCommand(['GET', statusKey]);
    if (status && status !== 'pending') {
      console.log(`Request ${requestId} is no longer pending, status: ${status}`);
      return;
    }
    
    // Get next driver from queue
    const nextDriverId = await redisClient.sendCommand(['LPOP', driverQueueKey]);
    
    if (!nextDriverId) {
      console.log(`No more drivers available for request ${requestId}`);
      // Update status to no_drivers_available
      await redisClient.sendCommand(['SET', statusKey, 'no_drivers_available']);
      await redisClient.sendCommand(['EXPIRE', statusKey, '600']);
      // Notify rider
      if (rideDetails) {
        await this.sendRiderNoDriverNotification(requestId, rideDetails);
      }
      return;
    }
    
    console.log(`Notifying driver ${nextDriverId} for request ${requestId}`);
    
    try {
      // Send FCM notification to driver
      await this.sendDriverNotification(nextDriverId, requestId, rideDetails);
      
      // Set current driver and wait for response
      await redisClient.sendCommand(['SET', currentDriverKey, nextDriverId]);
      await redisClient.sendCommand(['EXPIRE', currentDriverKey, '120']); // 2 minute timeout
      
      // Schedule timeout check
      setTimeout(() => {
        this.checkDriverTimeout(requestId, nextDriverId, rideDetails);
      }, 60000); // 60 seconds timeout
      
    } catch (error) {
      console.error(`Failed to notify driver ${nextDriverId}:`, error);
      // Move to next driver immediately on error
      setTimeout(() => {
        this.processDriverQueue(requestId, rideDetails);
      }, 1000);
    }
  }

  /**
   * Check if driver responded within timeout
   */
  async checkDriverTimeout(requestId, driverId, rideDetails) {
    const statusKey = `ride:request:${requestId}:status`;
    const currentDriverKey = `ride:request:${requestId}:current_driver`;
    
    // Check if request is still pending and driver is still current
    const [status, currentDriver] = await Promise.all([
      redisClient.sendCommand(['GET', statusKey]),
      redisClient.sendCommand(['GET', currentDriverKey])
    ]);
    
    if (status === 'accepted' || status === 'cancelled') {
      console.log(`Request ${requestId} already resolved with status: ${status}`);
      return;
    }
    
    if (currentDriver === driverId) {
      console.log(`Driver ${driverId} timed out for request ${requestId}, moving to next driver`);
      // Log the timeout
      await this.logDriverResponse(requestId, driverId, 'timeout');
      // Notify driver of expiration
      await this.sendDriverRequestExpiredNotification(driverId, requestId);
      // Process next driver
      this.processDriverQueue(requestId, rideDetails);
    }
  }

  /**
   * Send FCM notification to driver
   */
  async sendDriverNotification(driverId, requestId, rideDetails) {
    console.log(`Sending FCM to driver ${driverId} for request ${requestId}`);
    console.log(rideDetails);
    // For debugging
    console.log('rideDetails:', rideDetails);
    // Get driver's FCM token
    const driver = await userDb.getUserById ? 
      await userDb.getUserById(driverId) : 
      await userDb.getUserByUsername(driverId); // Fallback if getUserById doesn't exist
    
    if (!driver || !driver.fcm_token) {
      console.log(`Driver ${driverId} has no FCM token`);
      return;
    }
    // Construct trip object for notification
    const trip = {
      passengerPhone: rideDetails.passengerPhone,
      passengerId: rideDetails.passengerId || rideDetails.passenger_id,
      passengerName: rideDetails.passengerName || rideDetails.passenger_name,
      pickupLocation: {
        address: rideDetails.pickup?.address || rideDetails.pickup_address,
        latitude: rideDetails.pickup?.lat || rideDetails.pickup_lat,
        longitude: rideDetails.pickup?.lng || rideDetails.pickup_lng,
        name: rideDetails.pickup?.name || rideDetails.pickup_name || ''
      },
      dropoffLocation: {
        address: rideDetails.dropoff?.address || rideDetails.dropoff_address,
        latitude: rideDetails.dropoff?.lat || rideDetails.dropoff_lat,
        longitude: rideDetails.dropoff?.lng || rideDetails.dropoff_lng,
        name: rideDetails.dropoff?.name || rideDetails.dropoff_name || ''
      },
      distance: rideDetails.estimatedDistance || rideDetails.estimated_distance,
      duration: rideDetails.estimatedDuration || rideDetails.estimated_duration,
      priority: rideDetails.priority,
      proposedFare: rideDetails.proposedFare || rideDetails.proposed_fare
    };
    console.log('trip details:', trip);
    const message = {
      token: driver.fcm_token,
      notification: {
        title: 'New Ride Request',
        body: `Pickup at ${trip.pickupLocation.address}`
      },
      data: {
        requestId: requestId.toString(),
        trip: JSON.stringify(trip),
        type: 'ride_request'
      },
      android: {
        priority: 'high',
        ttl: 60000 // 60 seconds
      },
      apns: {
        headers: {
          'apns-priority': '10'
        },
        payload: {
          aps: {
            sound: 'default'
          }
        }
      }
    };

    const response = await admin.messaging().send(message);
    console.log(`FCM sent to driver ${driverId}:`, response);
    
    // For now, just log the notification
    console.log(`[MOCK FCM] Notifying driver ${driverId} for request ${requestId}`);
    console.log(`Pickup: ${rideDetails.pickup.address}`);
    console.log(`Dropoff: ${rideDetails.dropoff.address}`);
    console.log(`Fare: $${rideDetails.proposedFare}`);
  }

  /**
   * Send FCM notification to rider when no drivers are available
   */
  async sendRiderNoDriverNotification(requestId, rideDetails) {
    console.log(`Notifying rider ${rideDetails.passengerName} of no available drivers for request ${requestId}`);
    // Get rider's FCM token
    const rider = await userDb.getUserById ? 
      await userDb.getUserById(rideDetails.passengerId) : 
      await userDb.getUserByUsername(rideDetails.passengerId);
    if (!rider || !rider.fcm_token) {
      console.log(`Rider not found or doesn't have FCM token`);
      return;
    }
    const message = {
      token: rider.fcm_token,
      notification: {
        title: 'No Drivers Available',
        body: 'Sorry, no drivers are available for your request at this time.'
      },
      data: {
        requestId: requestId.toString(),
        type: 'no_drivers_available'
      },
      android: {
        priority: 'high',
        ttl: 60000
      },
      apns: {
        headers: {
          'apns-priority': '10'
        },
        payload: {
          aps: {
            sound: 'default'
          }
        }
      }
    };
    const response = await admin.messaging().send(message);
    console.log(`FCM sent to rider ${passengerId} for no drivers:`, response);
  }

  /**
   * Send FCM notification to driver when ride request expires or is unavailable
   */
  async sendDriverRequestExpiredNotification(driverId, requestId) {
    const driver = await userDb.getUserById ? 
      await userDb.getUserById(driverId) : 
      await userDb.getUserByUsername(driverId);
    if (!driver || !driver.fcm_token) {
      console.log(`Driver ${driverId} has no FCM token`);
      return;
    }
    const message = {
      token: driver.fcm_token,
      notification: {
        title: 'Ride Request Expired',
        body: 'This ride request is no longer available.'
      },
      data: {
        requestId: requestId.toString(),
        type: 'ride_request_expired'
      },
      android: {
        priority: 'high',
        ttl: 60000
      },
      apns: {
        headers: {
          'apns-priority': '10'
        },
        payload: {
          aps: {
            sound: 'default'
          }
        }
      }
    };
    const response = await admin.messaging().send(message);
    console.log(`FCM sent to driver ${driverId} for expired request:`, response);
  }

  /**
   * Handle driver response (accept/decline)
   */
  async handleDriverResponse(requestId, driverId, response, estimatedArrival = null) {
    const statusKey = `ride:request:${requestId}:status`;
    const currentDriverKey = `ride:request:${requestId}:current_driver`;
    
    // Check if this driver is the current one
    const currentDriver = await redisClient.sendCommand(['GET', currentDriverKey]);
    console.log(`Current driver for request ${requestId} is ${currentDriver}, response from ${driverId}`);
    if (currentDriver !== driverId) {
      console.log(`Driver ${driverId} is not the current driver for request ${requestId}`);
      return false;
    }
    
    // Log the response
    await this.logDriverResponse(requestId, driverId, response);
    
    if (response === 'accept') {
      // Update status to accepted
      await redisClient.sendCommand(['SET', statusKey, 'accepted']);
      await redisClient.sendCommand(['EXPIRE', statusKey, '3600']); // 1 hour
      
      // Store accepted driver info
      await redisClient.sendCommand(['SET', `ride:request:${requestId}:driver`, driverId]);
      await redisClient.sendCommand(['EXPIRE', `ride:request:${requestId}:driver`, '3600']);
      
      if (estimatedArrival) {
        await redisClient.sendCommand(['SET', `ride:request:${requestId}:eta`, estimatedArrival.toString()]);
        await redisClient.sendCommand(['EXPIRE', `ride:request:${requestId}:eta`, '3600']);
      }
      
      // Clean up queue
      await this.cleanupRequestQueue(requestId);
      
      console.log(`Driver ${driverId} accepted request ${requestId}`);
      return true;
      
    } else if (response === 'decline') {
      console.log(`Driver ${driverId} declined request ${requestId}, moving to next driver`);
      // Continue with next driver
      setTimeout(() => {
        this.processDriverQueue(requestId, { /* pass ride details */ });
      }, 1000);
      return true;
    }
    
    return false;
  }

  /**
   * Log driver response for analytics
   */
  async logDriverResponse(requestId, driverId, response) {
    const logKey = `ride:request:${requestId}:responses`;
    const timestamp = new Date().toISOString();
    const logEntry = JSON.stringify({ driverId, response, timestamp });
    
    await redisClient.sendCommand(['RPUSH', logKey, logEntry]);
    await redisClient.sendCommand(['EXPIRE', logKey, '86400']); // 24 hours
  }

  /**
   * Clean up Redis keys when request is resolved
   */
  async cleanupRequestQueue(requestId) {
    const keys = [
      `ride:request:${requestId}:queue`,
      `ride:request:${requestId}:current_driver`
    ];
    
    for (const key of keys) {
      await redisClient.sendCommand(['DEL', key]);
    }
  }

  /**
   * Get request status
   */
  async getRequestStatus(requestId) {
    const statusKey = `ride:request:${requestId}:status`;
    const driverKey = `ride:request:${requestId}:driver`;
    const etaKey = `ride:request:${requestId}:eta`;
    
    const [status, driverId, eta] = await Promise.all([
      redisClient.sendCommand(['GET', statusKey]),
      redisClient.sendCommand(['GET', driverKey]),
      redisClient.sendCommand(['GET', etaKey])
    ]);
    
    return {
      status: status || 'pending',
      driverId,
      estimatedArrival: eta
    };
  }
}

module.exports = new NotificationService();
