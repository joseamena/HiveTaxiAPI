
// src/services/notificationService.js
let admin = null;
const userDb = require('../db/users');
const redisClient = require('../db/redis');

// Initialize Firebase Admin (you'll need to add your service account key)
try {
  const serviceAccount = require('../config/firebase-service-account.json');
  admin = require('firebase-admin');
  if (!admin.apps || !admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin initialized');
  }
} catch (err) {
  console.warn('⚠️  Firebase not configured, push notifications disabled');
  admin = null;
}

class NotificationService {

  /**
   * Send a 'no drivers found' FCM notification to the rider
   * @param {string} userId - The rider's user ID
   * @param {string|number} requestId - The ride request ID
   */
  async sendNoDriverFoundToRider(userId, requestId) {
    const title = 'No Drivers Available';
    const body = 'Sorry, no drivers are available for your request at this time.';
    const data = {
      requestId: requestId.toString(),
      type: 'no_drivers_available'
    };
    return this._sendNotification(userId, title, body, data);
  }

  /**
   * Private helper to send FCM notification to a user by userId
   * @param {string} userId - The user's ID
   * @param {string} title - Notification title
   * @param {string} body - Notification body
   * @param {object} data - Additional data to send
   * @param {string} [type='notification'] - Type of notification (for data.type)
   */
  async _sendNotification(userId, title, body, data = {}) {
    try {
      let user;
      if (typeof userId === 'number' || (!isNaN(userId) && userId !== '')) {
        user = await userDb.getUserById(Number(userId));
      } else {
        user = await userDb.getUserByUsername(userId);
      }
      if (!user || !user.fcm_token) {
        console.log(`User ${userId} not found or doesn't have FCM token`);
        return;
      }
      const message = {
        token: user.fcm_token,
        notification: {
          title,
          body
        },
        data: Object.assign({}, data),
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
      if (!admin) {
        console.warn(`⚠️  Firebase not configured, skipping FCM to user ${userId}`);
        return;
      }
      const response = await admin.messaging().send(message);
      console.log(`FCM sent to user ${userId}:`, response);
    } catch (err) {
      console.error(`Error sending FCM to user ${userId}:`, err);
    }
  }
  /**
   * Send a generic FCM notification to a rider by userId
   * @param {string} userId - The rider's user ID
   * @param {string} title - Notification title
   * @param {string} body - Notification body
   * @param {object} data - Additional data to send (will be stringified)
   */
  async sendRiderNotification(userId, title, body, data = {}) {
    return this._sendNotification(userId, title, body, data, 'rider_notification');
  }

  /**
   * Send FCM notification to driver
   */
  async sendRideRequestToDriver(driverId, requestId, rideDetails) {
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
    const data = {
      requestId: requestId.toString(),
      trip: JSON.stringify(trip),
      type: 'ride_request'
    };
    return this._sendNotification(driverId, 'New Ride Request', `Pickup at ${trip.pickupLocation.address}`, data, 'ride_request');
  }
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
        await this.sendNoDriverFoundToRider(rideDetails.passengerId, requestId);
      }
      return;
    }

    console.log(`Notifying driver ${nextDriverId} for request ${requestId}`);

    try {
      // Send FCM notification to driver
      await this.sendRideRequestToDriver(nextDriverId, requestId, rideDetails);

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
    if (!admin) {
      console.warn(`⚠️  Firebase not configured, skipping FCM to driver ${driverId}`);
      return;
    }
    const response = await admin.messaging().send(message);
    console.log(`FCM sent to driver ${driverId} for expired request:`, response);
  }

  /**
   * Notify rider that a driver accepted their ride
   * @param {string|number} riderId - Rider's user ID or username
   * @param {string|number} requestId - Ride request ID
   * @param {string|number} driverId - Driver's user ID or username
   * @param {number|string|null} estimatedArrival - ETA in minutes (optional)
   */
  async sendRideAcceptedToRider(riderId, requestId, driverId, estimatedArrival = null) {
    try {
      // Attempt to get driver display information (optional)
      let driver;
      if (typeof driverId === 'number' || (!isNaN(driverId) && driverId !== '')) {
        driver = await userDb.getUserById(Number(driverId));
      } else {
        driver = await userDb.getUserByUsername(driverId);
      }

      const driverName = driver?.display_name || driver?.first_name || driver?.username || 'Your driver';
      const etaText = estimatedArrival ? ` ETA: ${estimatedArrival} min.` : '';

      const title = 'Ride Accepted';
      const body = `${driverName} accepted your ride.${etaText}`.trim();
      const data = {
        requestId: requestId.toString(),
        driverId: String(driverId),
        type: 'ride_accepted',
        eta: estimatedArrival != null ? String(estimatedArrival) : ''
      };

      return this._sendNotification(riderId, title, body, data);
    } catch (err) {
      console.error(`Error sending ride accepted notification to rider ${riderId}:`, err);
    }
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
