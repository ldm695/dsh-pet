'use strict';

function signatureOf(ids) {
  return JSON.stringify([...ids].map(String).sort());
}

/** Require consecutive identical monitor sets before accepting a fullscreen transition. */
class FullscreenDisplayStabilizer {
  constructor(requiredSamples = 2) {
    if (!Number.isInteger(requiredSamples) || requiredSamples < 1) {
      throw new TypeError('requiredSamples must be a positive integer');
    }
    this.requiredSamples = requiredSamples;
    this.stable = null;
    this.pendingSignature = null;
    this.pendingSet = null;
    this.pendingSamples = 0;
  }

  update(candidate) {
    const next = new Set([...candidate].map(String));
    const signature = signatureOf(next);
    if (this.stable === null) {
      this.stable = next;
      return new Set(next);
    }

    if (signature === signatureOf(this.stable)) {
      this.pendingSignature = null;
      this.pendingSet = null;
      this.pendingSamples = 0;
      return new Set(this.stable);
    }

    if (signature === this.pendingSignature) {
      this.pendingSamples += 1;
    } else {
      this.pendingSignature = signature;
      this.pendingSet = next;
      this.pendingSamples = 1;
    }

    if (this.pendingSamples >= this.requiredSamples) {
      this.stable = this.pendingSet;
      this.pendingSignature = null;
      this.pendingSet = null;
      this.pendingSamples = 0;
    }
    return new Set(this.stable);
  }
}

module.exports = { FullscreenDisplayStabilizer };
