/**
 * Desktop hosts change notifier tests.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  notifyDesktopHostsChanged,
  subscribeDesktopHostsChanged,
} from '../desktop-hosts-change-notifier';

describe('desktop-hosts-change-notifier', () => {
  beforeEach(() => {
    // Clean up any lingering subscribers
    // (each test creates fresh subscriptions)
  });

  test('subscriber is called on notification', () => {
    let callCount = 0;
    const unsubscribe = subscribeDesktopHostsChanged(() => { callCount++; });

    notifyDesktopHostsChanged();
    expect(callCount).toBe(1);

    notifyDesktopHostsChanged();
    expect(callCount).toBe(2);

    unsubscribe();
  });

  test('unsubscribe stops notifications', () => {
    let callCount = 0;
    const unsubscribe = subscribeDesktopHostsChanged(() => { callCount++; });

    notifyDesktopHostsChanged();
    expect(callCount).toBe(1);

    unsubscribe();

    notifyDesktopHostsChanged();
    expect(callCount).toBe(1); // Not called after unsubscribe
  });

  test('multiple subscribers all receive notification', () => {
    let countA = 0;
    let countB = 0;
    const unsubA = subscribeDesktopHostsChanged(() => { countA++; });
    const unsubB = subscribeDesktopHostsChanged(() => { countB++; });

    notifyDesktopHostsChanged();
    expect(countA).toBe(1);
    expect(countB).toBe(1);

    unsubA();
    unsubB();
  });

  test('subscriber error does not break other subscribers', () => {
    let countB = 0;
    const unsubA = subscribeDesktopHostsChanged(() => {
      throw new Error('boom');
    });
    const unsubB = subscribeDesktopHostsChanged(() => { countB++; });

    notifyDesktopHostsChanged();
    expect(countB).toBe(1);

    unsubA();
    unsubB();
  });
});
