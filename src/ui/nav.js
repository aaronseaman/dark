// Navigation registry: screens register openers here so modules don't import each other in cycles.
const reg = {};
export function register(name, fn) { reg[name] = fn; }
export function go(name, ...args) { return reg[name](...args); }
