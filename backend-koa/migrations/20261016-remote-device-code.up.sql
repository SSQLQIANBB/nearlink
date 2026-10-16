-- Existing devices receive a code lazily on their next authenticated host connection.
ALTER TABLE remote_devices
  ADD COLUMN deviceCode VARCHAR(9) NULL DEFAULT NULL,
  ADD UNIQUE INDEX remote_devices_device_code (deviceCode);
