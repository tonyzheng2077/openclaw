import type { ProactivityService } from "./service.js";

let instance: ProactivityService | null = null;

export function setProactivityService(service: ProactivityService | null) {
  instance = service;
}

export function getProactivityService(): ProactivityService | null {
  return instance;
}
