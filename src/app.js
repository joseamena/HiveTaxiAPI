// src/app.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./config/swagger');
require('dotenv').config();
const pool = require('./db');

const app = express();

// Middleware
app.use(helmet()); // Security headers
app.use(cors()); // Enable CORS
app.use(morgan('combined')); // Logging
app.use(express.json({ limit: '10mb' })); // Parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'Hive Taxi Driver API'
  });
});

// Swagger documentation routes
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Root route - redirect to documentation
app.get('/', (req, res) => {
  res.json({
    message: 'Hive Taxi API',
    version: '1.0.0',
    documentation: '/api-docs',
    health: '/health'
  });
});

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/drivers', require('./routes/drivers'));
app.use('/api/requests', require('./routes/requests'));
app.use('/api/trips', require('./routes/trips'));
app.use('/api/users', require('./routes/users'));
app.use('/api/communities', require('./routes/communities'));
app.use('/api/admin', require('./routes/admin'));

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Route not found',
    message: `${req.method} ${req.originalUrl} not found`
  });
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('❌ Error:', error);
  res.status(error.status || 500).json({
    error: error.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
  });
});

module.exports = app;
