-- NULL represents a persistent invitation. Existing expiry dates remain unchanged.
ALTER TABLE remote_assistance_grants MODIFY COLUMN expiresAt DATETIME NULL DEFAULT NULL;
