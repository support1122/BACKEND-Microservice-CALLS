'use strict';

const STATE = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
};

class CircuitBreaker {
  constructor(options = {}) {
    this._failureThreshold = options.failureThreshold || 5;
    this._resetTimeout = options.resetTimeout || 60000;
    this._halfOpenMax = options.halfOpenMax || 3;

    this._state = STATE.CLOSED;
    this._failureCount = 0;
    this._halfOpenAttempts = 0;
    this._lastFailureTime = null;
  }

  getState() {
    this._evaluateState();
    return this._state;
  }

  reset() {
    this._state = STATE.CLOSED;
    this._failureCount = 0;
    this._halfOpenAttempts = 0;
    this._lastFailureTime = null;
  }

  async execute(fn) {
    this._evaluateState();

    if (this._state === STATE.OPEN) {
      throw new Error('Circuit breaker is OPEN — request rejected');
    }

    if (this._state === STATE.HALF_OPEN && this._halfOpenAttempts >= this._halfOpenMax) {
      throw new Error('Circuit breaker HALF_OPEN limit reached — request rejected');
    }

    try {
      if (this._state === STATE.HALF_OPEN) {
        this._halfOpenAttempts++;
      }

      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      throw err;
    }
  }

  _evaluateState() {
    if (this._state === STATE.OPEN && this._lastFailureTime) {
      const elapsed = Date.now() - this._lastFailureTime;
      if (elapsed >= this._resetTimeout) {
        this._state = STATE.HALF_OPEN;
        this._halfOpenAttempts = 0;
      }
    }
  }

  _onSuccess() {
    this._failureCount = 0;
    this._halfOpenAttempts = 0;
    this._state = STATE.CLOSED;
  }

  _onFailure() {
    this._failureCount++;
    this._lastFailureTime = Date.now();

    if (this._state === STATE.HALF_OPEN || this._failureCount >= this._failureThreshold) {
      this._state = STATE.OPEN;
    }
  }
}

module.exports = CircuitBreaker;
