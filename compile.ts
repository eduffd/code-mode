// compile.ts — the ONE compile path for code_mode scripts.
//
// Every exec is parsed once with acorn and rewritten into the same shape: an
// async IIFE whose top-level declarations are captured onto globalThis. There
// is no native vm.Script fork and no TLA detection — a fix to compile
// semantics lands here once, and drift tests (test-compile.mjs) run against
// this module without forking a worker.
//
// Loadable from plain Node type stripping (the worker imports "./compile.ts")
// and compiles clean under the strict-tsc gate (tsconfig.json; ci.yml runs it,
// scripts/check-structure.mjs keeps the gate honest). Dependency-free besides acorn.

import { parse } from "acorn";

const PARSE_OPTIONS = {
	ecmaVersion: "latest",
	allowAwaitOutsideFunction: true,
	allowReturnOutsideFunction: true,
} as const;

// ---------------------------------------------------------------- AST shapes
// Only the node kinds this module reads. Acorn's output is external data:
// every field this module dereferences has a guard that validates it, and
// every other node stays opaque.

interface AstNode {
	readonly type: string;
	readonly start: number;
	readonly end: number;
}

interface IdentifierNode extends AstNode {
	readonly type: "Identifier";
	readonly name: string;
}

interface ObjectPatternNode extends AstNode {
	readonly type: "ObjectPattern";
	readonly properties: readonly unknown[];
}

interface ArrayPatternNode extends AstNode {
	readonly type: "ArrayPattern";
	readonly elements: readonly unknown[];
}

interface AssignmentPatternNode extends AstNode {
	readonly type: "AssignmentPattern";
	readonly left: unknown;
}

interface RestElementNode extends AstNode {
	readonly type: "RestElement";
	readonly argument: unknown;
}

interface PatternPropertyNode extends AstNode {
	readonly type: "Property";
	readonly value: unknown;
}

interface VariableDeclarationNode extends AstNode {
	readonly type: "VariableDeclaration";
	readonly kind: "var" | "let" | "const";
	readonly declarations: readonly { readonly id: unknown }[];
}

interface FunctionDeclarationNode extends AstNode {
	readonly type: "FunctionDeclaration";
	readonly id: IdentifierNode | null;
}

interface ClassDeclarationNode extends AstNode {
	readonly type: "ClassDeclaration";
	readonly id: IdentifierNode | null;
}

interface ExpressionStatementNode extends AstNode {
	readonly type: "ExpressionStatement";
}

interface ProgramNode extends AstNode {
	readonly type: "Program";
	readonly body: readonly AstNode[];
}

const isAstNode = (v: unknown): v is AstNode =>
	typeof v === "object" && v !== null && typeof (v as AstNode).type === "string";

const isProgramNode = (v: unknown): v is ProgramNode =>
	isAstNode(v) && v.type === "Program" && "body" in v && Array.isArray((v as { body: unknown }).body);

const isIdentifierNode = (v: unknown): v is IdentifierNode =>
	isAstNode(v) && v.type === "Identifier" && "name" in v && typeof (v as { name: unknown }).name === "string";

const isPatternPropertyNode = (v: unknown): v is PatternPropertyNode =>
	isAstNode(v) && v.type === "Property" && "value" in v;

const isObjectPatternNode = (v: unknown): v is ObjectPatternNode =>
	isAstNode(v) && v.type === "ObjectPattern" && "properties" in v && Array.isArray((v as { properties: unknown }).properties);

const isArrayPatternNode = (v: unknown): v is ArrayPatternNode =>
	isAstNode(v) && v.type === "ArrayPattern" && "elements" in v && Array.isArray((v as { elements: unknown }).elements);

const isAssignmentPatternNode = (v: unknown): v is AssignmentPatternNode =>
	isAstNode(v) && v.type === "AssignmentPattern" && "left" in v;

const isRestElementNode = (v: unknown): v is RestElementNode =>
	isAstNode(v) && v.type === "RestElement" && "argument" in v;

const isVariableDeclarationNode = (v: unknown): v is VariableDeclarationNode => {
	if (!isAstNode(v) || v.type !== "VariableDeclaration") return false;
	const kind = (v as { kind?: unknown }).kind;
	const decls = (v as { declarations?: unknown }).declarations;
	if (kind !== "var" && kind !== "let" && kind !== "const") return false;
	if (!Array.isArray(decls)) return false;
	return decls.every((d) => isAstNode(d) && "id" in d);
};

const isNamedDeclarationNode = (
	v: unknown,
	type: "FunctionDeclaration" | "ClassDeclaration",
): v is FunctionDeclarationNode | ClassDeclarationNode =>
	isAstNode(v) &&
	v.type === type &&
	"id" in v &&
	((v as { id: unknown }).id === null || isIdentifierNode((v as { id: unknown }).id));

const isExpressionStatementNode = (v: unknown): v is ExpressionStatementNode =>
	isAstNode(v) && v.type === "ExpressionStatement";

// ---------------------------------------------------------------- public types

export interface DeclarationRecord {
	readonly name: string;
	readonly kind: "var" | "let" | "const" | "function" | "class";
	readonly source: string;
}

export interface CompiledScript {
	readonly source: string;
	readonly capturedNames: readonly string[];
	readonly declarations: readonly DeclarationRecord[];
}

export interface CompileOptions {
	readonly persistedNames?: ReadonlySet<string>;
}

// ---------------------------------------------------------------- helpers

const patternNames = (node: unknown, acc: string[] = []): string[] => {
	if (isIdentifierNode(node)) {
		acc.push(node.name);
		return acc;
	}
	if (isObjectPatternNode(node)) {
		for (const prop of node.properties) {
			if (isPatternPropertyNode(prop)) patternNames(prop.value, acc);
		}
		return acc;
	}
	if (isArrayPatternNode(node)) {
		for (const el of node.elements) {
			if (el !== null) patternNames(el, acc);
		}
		return acc;
	}
	if (isAssignmentPatternNode(node)) return patternNames(node.left, acc);
	if (isRestElementNode(node)) return patternNames(node.argument, acc);
	return acc;
};

const declarationRecord = (stmt: AstNode, code: string): DeclarationRecord[] => {
	const source = code.slice(stmt.start, stmt.end);
	if (isVariableDeclarationNode(stmt)) {
		return stmt.declarations.flatMap((d) => patternNames(d.id).map((name) => ({ name, kind: stmt.kind, source })));
	}
	if (isNamedDeclarationNode(stmt, "FunctionDeclaration")) {
		return stmt.id ? [{ name: stmt.id.name, kind: "function", source }] : [];
	}
	if (isNamedDeclarationNode(stmt, "ClassDeclaration")) {
		return stmt.id ? [{ name: stmt.id.name, kind: "class", source }] : [];
	}
	return [];
};

const redeclareError = (name: string): SyntaxError =>
	new SyntaxError(`Identifier '${name}' has already been declared — reassign without const instead.`);

// ---------------------------------------------------------------- compile

export const compileScript = (code: string, opts: CompileOptions = {}): CompiledScript => {
	const parsed: unknown = parse(code, PARSE_OPTIONS);
	if (!isProgramNode(parsed)) throw new Error("acorn returned a non-Program AST");
	const statements = parsed.body;
	const perStatement = statements.map((stmt) => ({ stmt, records: declarationRecord(stmt, code) }));
	const declarations = perStatement.flatMap((p) => p.records);
	if (opts.persistedNames) {
		for (const d of declarations) {
			if (opts.persistedNames.has(d.name)) throw redeclareError(d.name);
		}
	}

	// const-cell and shared-first-accessor semantics live in DESIGN.md §5
	// (check-docs keeps them honest). Names come from IdentifierNode
	// (patternNames), so the bare-name splice is always valid source — Unicode
	// identifiers included; JSON.stringify makes the key name-agnostic.
	const last = statements[statements.length - 1];
	let source = "";
	let pos = 0;
	const spliced = new Set<string>();
	for (const { stmt, records } of perStatement) {
		if (stmt === last && isExpressionStatementNode(stmt)) {
			source += `${code.slice(pos, stmt.start)}return ${code.slice(stmt.start, stmt.end)};`;
		} else {
			source += code.slice(pos, stmt.end);
		}
		for (const d of records) {
			if (spliced.has(d.name)) continue;
			spliced.add(d.name);
			const key = JSON.stringify(d.name);
			source +=
				d.kind === "const"
					? `\n{ let cell = ${d.name}; Object.defineProperty(globalThis, ${key}, { get: () => cell, set: (v) => { cell = v; }, configurable: true, enumerable: true }); }`
					: `\nObject.defineProperty(globalThis, ${key}, { get: () => ${d.name}, set: (v) => { ${d.name} = v; }, configurable: true, enumerable: true });`;
		}
		pos = stmt.end;
	}
	source += code.slice(pos);

	return {
		source: `(async () => {\n${source}\n})()`,
		capturedNames: declarations.map((d) => d.name),
		declarations,
	};
};
