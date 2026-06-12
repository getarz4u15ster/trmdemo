// In-process event bus for real-time fan-out (SSE).
//
// The worker, risk engine, and admin routes publish domain events here; the
// GET /stream endpoint subscribes and pushes them to connected dashboards. In
// the customer's AWS environment this role is played by EventBridge / SNS (or
// DynamoDB Streams) feeding a WebSocket/SSE API — here it is a local analog.

const { EventEmitter } = require("events");

const bus = new EventEmitter();
bus.setMaxListeners(0); // many dashboards may subscribe

// Helper so callers don't repeat the event name.
function publish(event) {
  try {
    bus.emit("event", { ...event, at: new Date().toISOString() });
  } catch (e) {
    console.error("[bus] publish failed", e.message);
  }
}

module.exports = { bus, publish };
