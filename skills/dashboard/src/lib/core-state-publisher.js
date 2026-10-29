export function createCoreStateChangePublisher({ sse, buildStatePayload, scheduleFleetStateBroadcast }) {
  return () => {
    sse.broadcast('state_change', buildStatePayload());
    scheduleFleetStateBroadcast();
  };
}
