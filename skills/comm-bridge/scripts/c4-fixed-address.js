// Shared by routing and storage; fixed addresses never create topic groups.
export function fixedAddressSessionGroup(component, endpoint) {
  return component === 'dashboard' && endpoint === 'origin' ? 'origin' : null;
}
