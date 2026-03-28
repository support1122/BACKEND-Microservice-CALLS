'use strict';

const mongoose = require('mongoose');
const { MONGODB_URI } = require('../config/env');
const log = require('../utils/logger');

let isConnected = false;

async function connect() {
  if (isConnected) return;

  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is not defined');
  }

  mongoose.connection.on('connected', () => {
    isConnected = true;
    log.info('MongoDB connected');
  });

  mongoose.connection.on('disconnected', () => {
    isConnected = false;
    log.warn('MongoDB disconnected');
  });

  mongoose.connection.on('error', (err) => {
    log.error({ err }, 'MongoDB connection error');
  });

  await mongoose.connect(MONGODB_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });
}

async function disconnect() {
  if (!isConnected) return;
  await mongoose.disconnect();
  isConnected = false;
  log.info('MongoDB disconnected gracefully');
}

module.exports = { connect, disconnect };
