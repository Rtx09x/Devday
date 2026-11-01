const IMPORT_RE = /(^|\n)[ \t]*import(?:[ \t]+type)?[ \t]+([\s\S]*?)[ \t]+from[ \t]+(['"])[^'"\r\n]+\3[ \t]*;?[ \t]*(?=\r?\n|$)/g;

function importedBindingNames(clause: string): string[] {
  const names: string[] = [];
  const trimmed = clause.trim();
  const namedStart = trimmed.indexOf('{');
  const namedEnd = trimmed.lastIndexOf('}');

  if (namedStart >= 0 && namedEnd > namedStart) {
    const named = trimmed.slice(namedStart + 1, namedEnd);
    for (const specifier of named.split(',')) {
      const parts = specifier
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/);
      const localName = parts.at(-1)?.trim();
      if (localName) names.push(localName);
    }
  }

  const beforeNamed = (namedStart >= 0 ? trimmed.slice(0, namedStart) : trimmed).replace(/,$/, '').trim();
  const namespaceMatch = beforeNamed.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
  if (namespaceMatch) {
    names.push(namespaceMatch[1]);
  } else if (beforeNamed && /^[A-Za-z_$][\w$]*$/.test(beforeNamed)) {
    names.push(beforeNamed);
  }

  return names;
}

/**
 * Turns Replicad's generated external-module declaration into a self-contained
 * ambient module suitable for Monaco's addExtraLib API.
 *
 * The generated file imports low-level OCCT/manifold implementation types.
 * Those packages are not available to Monaco's browser worker, so their local
 * bindings become `any` while Replicad's own public declarations and JSDoc are
 * preserved. This deliberately degrades only implementation-facing types.
 */
export function wrapDtsAsAmbientModule(source: string, moduleName: string): string {
  const importedNames = new Set<string>();
  const withoutImports = source.replace(IMPORT_RE, (_statement, leadingNewline: string, clause: string) => {
    for (const name of importedBindingNames(clause)) importedNames.add(name);
    return leadingNewline;
  });

  if (/^\s*import(?:\s|\{)/m.test(withoutImports)) {
    throw new Error('Unsupported import syntax in Replicad declarations');
  }

  const body = withoutImports
    .replace(/^\s*export\s*\{\s*\}\s*;?\s*$/gm, '')
    .replace(
      /\bdeclare\s+(?=(?:abstract\s+)?(?:class|interface|type|function|const|let|var|enum|namespace)\b)/g,
      ''
    )
    .trim();
  const implementationAliases = [...importedNames]
    .sort()
    .map((name) => {
      const qualifiedMembers = new Set<string>();
      const qualifiedMemberRe = new RegExp(`\\b${name}\\.([A-Za-z_$][\\w$]*)`, 'g');
      for (const match of body.matchAll(qualifiedMemberRe)) qualifiedMembers.add(match[1]);
      if (qualifiedMembers.size > 0) {
        const members = [...qualifiedMembers].sort().map((member) => `  type ${member} = any;`).join('\n');
        return `namespace ${name} {\n${members}\n}`;
      }
      // Replicad's generic Shape wrappers require the low-level OCCT base shape
      // to meet their public Deletable constraint.
      if (name === 'TopoDS_Shape') return 'type TopoDS_Shape = Deletable;';
      return `type ${name} = any;`;
    })
    .join('\n');
  const indented = `${implementationAliases}\n\n${body}`
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');

  return `declare module ${JSON.stringify(moduleName)} {\n${indented}\n}\n`;
}

export const REPLICAD_MODEL_CONTRACT_DTS = `
/** A value supported by the Replicad Customizer parameter contract. */
type ReplicadParameterValue = number | boolean | string | readonly [number, number, number];

interface ReplicadNumberParameterDefinition {
  kind: 'number';
  default: number;
  label?: string;
  group?: string;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
}

interface ReplicadBooleanParameterDefinition {
  kind: 'boolean';
  default: boolean;
  label?: string;
  group?: string;
  description?: string;
}

interface ReplicadEnumParameterDefinition {
  kind: 'enum';
  default: string;
  options: readonly string[];
  label?: string;
  group?: string;
  description?: string;
}

interface ReplicadVectorParameterDefinition {
  kind: 'vector';
  default: readonly [number, number, number];
  label?: string;
  group?: string;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
}

interface ReplicadStringParameterDefinition {
  kind: 'string';
  default: string;
  label?: string;
  group?: string;
  description?: string;
}

/** One entry in a model's exported parameterDefinitions object. */
type ReplicadParameterDefinition =
  | ReplicadNumberParameterDefinition
  | ReplicadBooleanParameterDefinition
  | ReplicadEnumParameterDefinition
  | ReplicadVectorParameterDefinition
  | ReplicadStringParameterDefinition;

/** The supported shape of a model's exported defaultParams object. */
type ReplicadDefaultParams = Record<string, ReplicadParameterValue>;

/**
 * Type helper for the exported parameterDefinitions convention.
 * Example: export const parameterDefinitions = { ... } satisfies
 * ReplicadParameterDefinitions<typeof defaultParams>;
 */
type ReplicadParameterDefinitions<T extends ReplicadDefaultParams = ReplicadDefaultParams> = {
  [K in keyof T]: ReplicadParameterDefinition;
};

/**
 * Returns a fresh clone of a STEP asset loaded from the current project.
 * The name is the asset's basename, such as imported('motor.step').
 */
declare function imported(name: string): import('replicad').AnyShape;
`;
