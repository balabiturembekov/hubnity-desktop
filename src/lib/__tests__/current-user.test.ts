/**
 * Unit тесты для current-user
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setCurrentUser, getCurrentUser } from '../current-user';
import type { LoginResponse } from '../api';

describe('current-user', () => {
  beforeEach(() => {
    setCurrentUser(null);
  });

  it('getCurrentUser returns null initially', () => {
    expect(getCurrentUser()).toBeNull();
  });

  it('setCurrentUser and getCurrentUser work', () => {
    const user: LoginResponse['user'] = {
      id: '1',
      name: 'Test',
      email: 'test@example.com',
      role: 'user',
      status: 'active',
      avatar: '',
      hourlyRate: 0,
      companyId: 'c1',
      company: { id: 'c1', name: 'Company' },
    };
    setCurrentUser(user);
    expect(getCurrentUser()).toEqual(user);
  });

  it('setCurrentUser(null) clears user', () => {
    const user: LoginResponse['user'] = {
      id: '1',
      name: 'Test',
      email: 'test@example.com',
      role: 'user',
      status: 'active',
      avatar: '',
      hourlyRate: 0,
      companyId: 'c1',
      company: { id: 'c1', name: 'Company' },
    };
    setCurrentUser(user);
    setCurrentUser(null);
    expect(getCurrentUser()).toBeNull();
  });
});
