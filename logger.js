/**
 * src/logger.js - Sistema de logging estruturado
 */

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LOG_LEVELS.info;

function formatTimestamp() {
  return new Date().toISOString();
}

function formatMessage(level, module, message, ...args) {
  const timestamp = formatTimestamp();
  const levelStr = level.toUpperCase().padEnd(5);
  const moduleStr = module ? `[${module}]` : '';
  
  return `${timestamp} ${levelStr} ${moduleStr} ${message}`;
}

function shouldLog(level) {
  return LOG_LEVELS[level] >= CURRENT_LEVEL;
}

function createLogger(module = '') {
  return {
    debug(message, ...args) {
      if (shouldLog('debug')) {
        console.log(formatMessage('debug', module, message), ...args);
      }
    },
    
    info(message, ...args) {
      if (shouldLog('info')) {
        console.log(formatMessage('info', module, message), ...args);
      }
    },
    
    warn(message, ...args) {
      if (shouldLog('warn')) {
        console.warn(formatMessage('warn', module, message), ...args);
      }
    },
    
    error(message, ...args) {
      if (shouldLog('error')) {
        console.error(formatMessage('error', module, message), ...args);
      }
    }
  };
}

module.exports = { createLogger };
