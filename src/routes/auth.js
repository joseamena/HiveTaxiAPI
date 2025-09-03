const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Client, PublicKey, Signature } = require('@hiveio/dhive');
const elliptic = require('elliptic');
const EC = elliptic.ec;
const ec = new EC('secp256k1');
const userDb = require('../db/users');

const router = express.Router();

// Initialize Hive client
const hiveClient = new Client(['https://api.hive.blog']);

// Store challenges temporarily (use Redis in production)
const challenges = new Map();

// Authentication routes for drivers

// POST /api/auth/register - Register a new driver
router.post('/register', (req, res) => {
  try {
    const { email, password, firstName, lastName, phone, licenseNumber } = req.body;
    
    // Validation
    if (!email || !password || !firstName || !lastName || !phone || !licenseNumber) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['email', 'password', 'firstName', 'lastName', 'phone', 'licenseNumber']
      });
    }

    // TODO: Hash password, save to database, generate JWT
    res.status(201).json({
      message: 'Driver registered successfully',
      driver: {
        id: Date.now().toString(),
        email,
        firstName,
        lastName,
        phone,
        licenseNumber,
        status: 'pending_verification'
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login - Driver login
router.post('/login', (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({
        error: 'Email and password are required'
      });
    }

    // TODO: Verify credentials, generate JWT
    res.json({
      message: 'Login successful',
      token: 'mock-jwt-token',
      driver: {
        id: '1',
        email,
        firstName: 'John',
        lastName: 'Doe',
        status: 'active'
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/logout - Driver logout
router.post('/logout', (req, res) => {
  try {
    // TODO: Invalidate JWT token
    res.json({ message: 'Logout successful' });
  } catch (error) {
    res.status(500).json({ error: 'Logout failed' });
  }
});

// POST /api/auth/refresh - Refresh JWT token
router.post('/refresh', (req, res) => {
  try {
    const { refreshToken } = req.body;
    
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    // TODO: Verify refresh token, generate new access token
    res.json({
      message: 'Token refreshed',
      token: 'new-mock-jwt-token'
    });
  } catch (error) {
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// POST /api/auth/forgot-password - Request password reset
router.post('/forgot-password', (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // TODO: Generate reset token, send email
    res.json({ message: 'Password reset email sent' });
  } catch (error) {
    res.status(500).json({ error: 'Password reset request failed' });
  }
});

// HIVE BLOCKCHAIN AUTHENTICATION ROUTES

// POST /api/auth/challenge - Get authentication challenge for Hive login
router.post('/challenge', async (req, res) => {
  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'Hive username is required' });
    }

    // Verify account exists on Hive
    const accounts = await hiveClient.database.getAccounts([username]);
    if (!accounts || accounts.length === 0) {
      return res.status(404).json({ error: 'Account not found on Hive blockchain' });
    }

    // Generate random challenge
    const challenge = crypto.randomBytes(32).toString('hex');
    const timestamp = Date.now();

    // Store challenge temporarily (expires in 5 minutes)
    challenges.set(username, {
      challenge,
      timestamp,
      expires: timestamp + (5 * 60 * 1000)
    });

    // Clean up expired challenges
    setTimeout(() => {
      challenges.delete(username);
    }, 5 * 60 * 1000);

    res.json({
      challenge,
      timestamp,
      message: 'Sign this challenge with your Hive posting key',
      instructions: `Please sign the message: "${username}:${challenge}:${timestamp}"`
    });

  } catch (error) {
    console.error('Challenge generation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/verify - Verify signed challenge and login with Hive
router.post('/verify', async (req, res) => {
  try {
    const { username, challenge, timestamp, signature } = req.body;

    if (!username || !challenge || !timestamp || !signature) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['username', 'challenge', 'timestamp', 'signature']
      });
    }

    // Check if challenge exists and is valid
    const storedChallenge = challenges.get(username);
    if (!storedChallenge) {
      return res.status(400).json({ error: 'Challenge not found or expired' });
    }

    if (storedChallenge.challenge !== challenge || storedChallenge.timestamp !== timestamp) {
      return res.status(400).json({ error: 'Invalid challenge' });
    }

    if (Date.now() > storedChallenge.expires) {
      challenges.delete(username);
      return res.status(400).json({ error: 'Challenge expired' });
    }

    // Get account's posting public keys from Hive
    const accounts = await hiveClient.database.getAccounts([username]);
    if (!accounts || accounts.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const account = accounts[0];
    const postingKeys = account.posting.key_auths.map(([key]) => key);

    // Verify signature
    const message = `${username}:${challenge}:${timestamp}`;
    console.log('🔏 Message:', message);
    console.log('🔏 Signature (hex):', signature);
    const messageHash = crypto.createHash('sha256').update(message, 'utf8').digest();
    console.log('🔏 Message SHA-256 (hex):', messageHash.toString('hex'));
    let signatureBuffer;
    try {
      signatureBuffer = Buffer.from(signature, 'hex');
      console.log('Signature buffer length:', signatureBuffer.length);
    } catch (e) {
      console.error('Error converting signature to buffer:', e);
      return res.status(400).json({ error: 'Invalid signature format' });
    }
    let isValidSignature = false;

    for (const pubKeyString of postingKeys) {
      console.log('🔑 Verifying with public key:', pubKeyString);
      try {
        // Decode STM... key to compressed buffer using dhive
        const dhivePubKey = PublicKey.fromString(pubKeyString);
        const compressedHex = dhivePubKey.key.toString('hex');
        console.log('Public key hex:', compressedHex);
        const key = ec.keyFromPublic(compressedHex, 'hex');
        const hashHex = messageHash.toString('hex');
        const sig = {
          r: signatureBuffer.slice(0, 32).toString('hex'),
          s: signatureBuffer.slice(32, 64).toString('hex'),
          recoveryParam: signatureBuffer[64]
        };
        console.log('r:', sig.r);
        console.log('s:', sig.s);
        console.log('recoveryParam:', sig.recoveryParam);
        const isValid = key.verify(hashHex, sig);
        if (isValid) {
          isValidSignature = true;
          break;
        }
      } catch (error) {
        console.error('Signature verification error:', error);
        continue;
      }
    }

    if (!isValidSignature) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Clean up used challenge
    challenges.delete(username);

    // Create or update driver in your system
    const driver = await findOrCreateDriver(username, account);

    // Generate JWT token
    const token = jwt.sign(
      { 
        driverId: driver.id,
        username: username,
        authMethod: 'hive_posting_key',
        type: 'driver'
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Hive authentication successful',
      token,
      user: {
        id: driver.id,
        hiveAccount: {
          name: account.name,
          reputation: account.reputation,
          created: account.created
        },
        displayName: driver.display_name || `${account.name}`,
        licenseNumber: driver.license_number,
        phoneNumber: driver.phone_number,
        verificationStatus: driver.verification_status || 'pending_verification',
        authMethod: 'hive'
      }
    });

  } catch (error) {
    console.error('Hive verification error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper function to find or create driver from Hive account
async function findOrCreateDriver(username) {
  // Try to find driver by Hive username

  let user = await userDb.getUserByUsername(username);
  if (user && user.type === 'driver') {
    // Update lastLogin and hiveData (if you have such columns)
    // For now, just return the driver
    return user;
  }
  // Create new driver
  driver = await userDb.createUser({
    hiveUsername: username,
    type: 'driver',
    completedTrips: 0,
    rating: 0,
    licenseNumber: null,
    lastLat: null,
    lastLong: null,
    phoneNumber: null,
    displayName: null,
    vehicle: null,
    isOnline: false
  });

  return driver;
}

module.exports = router;
