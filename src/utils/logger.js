'use strict';

const pino = require('pino');
const { NODE_ENV } = require('../config/env');

const logger = pino({
  name: 'microservice-arc',
  level: NODE_ENV === 'development' ? 'debug' : 'info',
  ...(NODE_ENV === 'development' && {
    transport: {
      target: 'pino/file',
      options: { destination: 1 },
    },
  }),
});

module.exports = logger;
