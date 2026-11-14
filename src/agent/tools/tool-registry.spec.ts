import type { AgentTool } from './agent-tool';
import { ToolRegistry } from './tool-registry';

function tool(name: string): AgentTool {
  return { name, description: `${name} tool`, inputSchema: {}, execute: () => Promise.resolve([]) };
}

describe('ToolRegistry', () => {
  it('names the tool that collided', () => {
    // The error used to read "Duplicate agent tool name registered: " with no
    // name, because `!seen.add(name)` is always false — `Set.add` returns the set.
    expect(
      () => new ToolRegistry([tool('mail_search'), tool('chat_search'), tool('mail_search')]),
    ).toThrow('Duplicate agent tool name registered: mail_search');
  });

  it('lists each colliding name once, however many times it repeats', () => {
    expect(() => new ToolRegistry([tool('a'), tool('a'), tool('a'), tool('b'), tool('b')])).toThrow(
      'Duplicate agent tool name registered: a, b',
    );
  });
});
