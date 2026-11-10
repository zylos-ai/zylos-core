// Shared by receive routing and storage; fixed addresses never create topic groups.
export function fixedAddressSessionGroup(channel, endpoint) {
  return channel === 'dashboard' && endpoint === 'origin' ? 'origin' : null;
}
