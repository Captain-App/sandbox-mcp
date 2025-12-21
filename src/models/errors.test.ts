import { describe, it, expect } from 'vitest';
import { SessionNotFoundError, StorageReadError, isSessionError, isStorageError } from './errors';

describe('Error Models', () => {
	it('should create SessionNotFoundError with correct message', () => {
		const error = new SessionNotFoundError({ sessionId: 'test-123' });

		expect(error._tag).toBe('SessionNotFoundError');
		expect(error.sessionId).toBe('test-123');
		expect(error.message).toContain('test-123');
	});

	it('should identify session errors with type guard', () => {
		const error = new SessionNotFoundError({ sessionId: 'test' });

		expect(isSessionError(error)).toBe(true);
		expect(isSessionError(new Error('random'))).toBe(false);
	});

	it('should create StorageReadError with cause', () => {
		const error = new StorageReadError({
			key: 'session:test-1',
			cause: 'Connection refused',
		});

		expect(error._tag).toBe('StorageReadError');
		expect(error.key).toBe('session:test-1');
		expect(isStorageError(error)).toBe(true);
	});
});
