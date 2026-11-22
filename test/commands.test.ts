import { Arbitrary, Schema } from "effect";
import { expect } from "vite-plus/test";
import { AGENT_SLUG, COMMANDS, menuWith, RESERVED_COMMANDS } from "../src/command-list.ts";
import { property } from "./property.ts";

const RESERVED = [...COMMANDS.map((c) => c.command), "start"];

const text = Arbitrary.schema(Schema.String).pipe(
  Arbitrary.filter((value) => !/\p{Cs}/u.test(value)),
);

const slug = Arbitrary.all({
  reserved: Arbitrary.schema(Schema.Boolean),
  taken: Arbitrary.schema(Schema.Literals(RESERVED as [string, ...string[]])),
  free: Arbitrary.schema(Schema.String.check(Schema.isPattern(AGENT_SLUG))),
}).pipe(Arbitrary.map(({ reserved, taken, free }) => (reserved ? taken : free)));

const role = Arbitrary.all({
  lines: Arbitrary.array(text, { maxLength: 3 }),
  padding: Arbitrary.schema(Schema.Literals(["", " ", "\n", " \n\t"])),
  long: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 300 }))),
}).pipe(
  Arbitrary.map(
    ({ lines, padding, long }) => padding + "r".repeat(long) + lines.join("\n") + padding,
  ),
);

const agents = Arbitrary.array(Arbitrary.all({ slug, name: text, role }), { maxLength: 6 });

property(
  "every built-in command has a unique lowercase name up to 32 characters and a description up to 256",
  Arbitrary.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: COMMANDS.length - 1 })),
  ),
  (index) => {
    const { command, description } = COMMANDS[index]!;
    expect(command).toMatch(/^[a-z_]{1,32}$/);
    expect(COMMANDS.filter((c) => c.command === command)).toHaveLength(1);
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(256);
    expect(RESERVED_COMMANDS.has(command)).toBe(true);
  },
);

property(
  "the menu keeps the built-in commands first and adds each agent whose slug is not reserved, in order",
  agents,
  (list) => {
    const menu = menuWith(list);
    expect(menu.slice(0, COMMANDS.length)).toEqual(COMMANDS.map((c) => ({ ...c })));
    expect(menu.slice(COMMANDS.length).map((c) => c.command)).toEqual(
      list.map((a) => a.slug).filter((s) => !RESERVED.includes(s)),
    );
  },
);

property(
  "an agent's menu description is its name and the first line of its role, cut to 256 characters with an ellipsis",
  agents,
  (list) => {
    const added = menuWith(list).slice(COMMANDS.length);
    const kept = list.filter((a) => !RESERVED.includes(a.slug));
    kept.forEach((agent, i) => {
      const firstLine = agent.role.trim().split("\n")[0]!;
      const full = firstLine === "" ? `Ask ${agent.name}` : `${agent.name}: ${firstLine}`;
      const description = added[i]!.description;
      expect(description.length).toBeLessThanOrEqual(256);
      if (full.length <= 256) {
        expect(description).toBe(full);
      } else {
        expect(description).toHaveLength(256);
        expect(description.endsWith("…")).toBe(true);
        expect(full.startsWith(description.slice(0, 255))).toBe(true);
      }
    });
  },
);
