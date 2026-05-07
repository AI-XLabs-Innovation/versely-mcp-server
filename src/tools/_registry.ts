import type { Tool } from "./_types.js";

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
  }

  registerMany(tools: readonly Tool[]): void {
    for (const t of tools) this.register(t);
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.#tools.values());
  }

  size(): number {
    return this.#tools.size;
  }
}
