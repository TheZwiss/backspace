// Frontend permission helpers — wraps shared permission constants.
// Always works with string representations (never raw bigint in state).

export {
  PermissionBits,
  ALL_PERMISSIONS,
  DEFAULT_EVERYONE_PERMISSIONS,
  hasPermissionBit,
  permissionsToString,
  stringToPermissions,
} from '@opencord/shared/src/permissions';
