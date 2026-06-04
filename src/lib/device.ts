const DEVICE_ID_STORAGE_KEY = 'custom-ledger-device-id'

function generateDeviceId() {
  return `device-${crypto.randomUUID()}`
}

export function getOrCreateDeviceId() {
  const existing = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY)
  if (existing) {
    return existing
  }

  const deviceId = generateDeviceId()
  window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, deviceId)
  return deviceId
}

export function formatDeviceId(deviceId: string) {
  if (deviceId.length <= 18) {
    return deviceId
  }

  return `${deviceId.slice(0, 14)}...${deviceId.slice(-8)}`
}
