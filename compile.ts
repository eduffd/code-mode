// compile.ts — the ONE compile path for code_mode scripts.
//
// Every exec is parsed once with acorn and rewritten into the same shape: an
// async IIFE whose top-level declarations are captured onto globalThis. There
// is no native vm.Script fork and no TLA detection — a fix to compile
// semantics lands here once, and drift tests (test-compile.mjs) run against
// this module without forking a worker.
//
// Semantics (one story):
// - top-level `await` and `return` work (the IIFE provides them);
// - the last top-level expression statement is returned, so completion values
//   behave like a REPL (`1 + 1` yields 2);
// - top-level declarations persist: each is captured to `globalThis.<name>`;
// - redeclaring a name an earlier exec already captured throws the taught
//   error ("... has already been declared — reassign without const instead").
//   Plain assignment (`x = 2`) is the reassignment channel.
//
// Loadable from plain Node type stripping (the worker imports "./compile.ts")
// and from the tsc gate. Dependency-free besides acorn.

import { parse } from "acorn";

const PARSE_OPTIONS = {
	ecmaVersion: "latest",
	allowAwaitOutsideFunction: true,
	allowReturnOutsideFunction: true,
} as const;

// ---------------------------------------------------------------- AST shapes
// Only the node kinds this module reads. The `type` discriminant plus the
// field guards below are the boundary: acorn guarantees estree shapes for a
// successful parse, and anything this module does not consume stays `unknown`.

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
	readonly properties: readonly PatternElementNode[];
}

interface ArrayPatternNode extends AstNode {
	readonly type: "ArrayPattern";
	readonly elements: readonly (PatternNode | null)[];
}

interface AssignmentPatternNode extends AstNode {
	readonly type: "AssignmentPattern";
	readonly left: PatternNode;
}

interface RestElementNode extends AstNode {
	readonly type: "RestElement";
	readonly argument: PatternNode;
}

interface PatternPropertyNode extends AstNode {
	readonly type: "Property";
	readonly value: PatternNode;
}

/** A binding target: the kinds that carry names, plus the non-binding rest. */
type PatternNode =
	| IdentifierNode
	| ObjectPatternNode
	| ArrayPatternNode
	| AssignmentPatternNode
	| RestElementNode
	| AstNode;

type PatternElementNode = PatternNode;

interface VariableDeclarationNode extends AstNode {
	readonly type: "VariableDeclaration";
	readonly kind: "var" | "let" | "const";
	readonly declarations: readonly { readonly id: PatternNode }[];
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
	readonly expression: AstNode;
}

interface ProgramNode extends AstNode {
	readonly type: "Program";
	readonly body: readonly AstNode[];
}

const isProgramNode = (v: unknown): v is ProgramNode =>
	isAstNode(v) && v.type === "Program" && "body" in v && Array.isArray((v as { body: unknown }).body);

const isAstNode = (v: unknown): v is AstNode =>
	typeof v === "object" && v !== null && typeof (v as AstNode).type === "string";

const isPatternProperty = (v: unknown): v is PatternPropertyNode =>
	isAstNode(v) && v.type === "Property" && "value" in v && isAstNode((v as PatternPropertyNode).value);

const isVariableDeclaration = (v: unknown): v is VariableDeclarationNode => {
	if (!isAstNode(v) || v.type !== "VariableDeclaration") return false;
	const decls = (v as { declarations?: unknown }).declarations;
	if (!Array.isArray(decls)) return false;
	return decls.every((d) => isAstNode(d) && "id" in d && isAstNode((d as { id: unknown }).id));
};

const isExpressionStatement = (v: unknown): v is ExpressionStatementNode =>
	isAstNode(v) && v.type === "ExpressionStatement" && "expression" in v && isAstNode((v as { expression: unknown }).expression);

// ---------------------------------------------------------------- public types

/** One captured top-level declaration: the journal a snapshot/restore replays. */
export interface DeclarationRecord {
	readonly name: string;
	readonly kind: "var" | "let" | "const" | "function" | "class";
	/** Source text of the whole declaration statement. */
	readonly source: string;
}

export interface CompiledScript {
	/** The async-IIFE source — the single form every exec runs as. */
	readonly source: string;
	/** Names the rewrite captures onto globalThis (same set as `declarations`). */
	readonly capturedNames: readonly string[];
	/** Per-declaration journal: name, kind, source. */
	readonly declarations: readonly DeclarationRecord[];
}

export interface CompileOptions {
	/** Names earlier execs already captured; redeclaring any of them throws. */
	readonly persistedNames?: ReadonlySet<string>;
}

// ---------------------------------------------------------------- helpers

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const patternNames = (node: PatternNode, acc: string[] = []): string[] => {
	switch (node.type) {
		case "Identifier":
			acc.push(node.name);
			return acc;
		case "ObjectPattern":
			for (const prop of node.properties) {
				if (isPatternProperty(prop)) patternNames(prop.value, acc);
			}
			return acc;
		case "ArrayPattern":
			for (const el of node.elements) {
				if (el !== null) patternNames(el, acc);
			}
			return acc;
		case "AssignmentPattern":
			return patternNames(node.left, acc);
		case "RestElement":
			return patternNames(node.argument, acc);
		default:
			// MemberExpression and anything else binds nothing.
			return acc;
	}
};

const declarationRecord = (stmt: AstNode, code: string): DeclarationRecord[] => {
	const source = code.slice(stmt.start, stmt.end);
	switch (stmt.type) {
		case "VariableDeclaration": {
			if (!isVariableDeclaration(stmt)) return [];
			return stmt.declarations.flatMap((d) =>
				patternNames(d.id).map((name) => ({ name, kind: stmt.kind, source })),
			);
		}
		case "FunctionDeclaration":
		case "ClassDeclaration": {
			const id = (stmt as FunctionDeclarationNode | ClassDeclarationNode).id;
			return id ? [{ name: id.name, kind: stmt.type === "FunctionDeclaration" ? "function" : "class", source }] : [];
		}
		default:
			return [];
	}
};

const redeclareError = (name: string): SyntaxError =>
	new SyntaxError(`Identifier '${name}' has already been declared — reassign without const instead.`);

// ---------------------------------------------------------------- compile

/**
 * The one compile path: parse once with acorn, rewrite into an async IIFE
 * with globalThis capture. Throws acorn's SyntaxError for invalid code and a
 * SyntaxError with the taught message when a top-level declaration redeclares
 * a persisted name.
 */
export const compileScript = (code: string, opts: CompileOptions = {}): CompiledScript => {
	const parsed: unknown = parse(code, PARSE_OPTIONS);
	if (!isProgramNode(parsed)) throw new Error("acorn returned a non-Program AST");
	const statements = parsed.body;

	// One record per statement, reused for both the redeclare check and the splice.
	const perStatement = statements.map((stmt) => ({ stmt, records: declarationRecord(stmt, code) }));
	const declarations = perStatement.flatMap((p) => p.records);
	if (opts.persistedNames) {
		for (const d of declarations) {
			if (opts.persistedNames.has(d.name)) throw redeclareError(d.name);
		}
	}

	// Splice `globalThis.<name> = <name>;` after each top-level declaration.
	// The original declaration stays as-is (it works inside the IIFE); the
	// appended lines copy the binding into persistent globalThis storage. The
	// last top-level expression statement becomes an explicit `return` so the
	// IIFE reproduces the native Script completion-value semantics.
	const last = statements[statements.length - 1];
	let source = "";
	let pos = 0;
	for (const { stmt, records } of perStatement) {
		if (stmt === last && isExpressionStatement(stmt)) {
			source += `${code.slice(pos, stmt.start)}return ${code.slice(stmt.start, stmt.end)};`;
		} else {
			source += code.slice(pos, stmt.end);
		}
		if (records.length > 0) {
			source +=
				"\n" +
				records
					.map((d) => (IDENT_RE.test(d.name) ? `globalThis.${d.name} = ${d.name};` : `globalThis[${JSON.stringify(d.name)}] = ${d.name};`))
					.join("\n");
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
