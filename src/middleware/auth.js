const jwt = require('jsonwebtoken');

function authenticateJWT(req, res, next) {
  // TODO: REMOVE THIS TESTING CODE - Hardcoded fake token for testing
  const fakeTestToken = 'test_token_coolmole_12345';
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization token required' });
  }
  const token = authHeader.split(' ')[1];
  
  // TESTING: Allow fake token to resolve to coolmole user
  if (token === fakeTestToken) {
    req.user = { driverId: 'coolmole',  username: "coolmole", authMethod: "hive_posting_key" };
    return next();
  }
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = authenticateJWT;
