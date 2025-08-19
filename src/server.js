// src/server.js
const app = require('./app');
const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`🚀 Hive Taxi Driver API running on port ${port}`);
  console.log(`📱 Environment: ${process.env.NODE_ENV || 'development'}`);
});
