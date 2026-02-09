import type { LoginResponse } from './api';

let currentUser: LoginResponse['user'] | null = null;

export function setCurrentUser(user: LoginResponse['user'] | null): void {
  currentUser = user;
}

export function getCurrentUser(): LoginResponse['user'] | null {
  return currentUser;
}
