import Parser from 'tree-sitter';
import Rust from 'tree-sitter-rust';
const parser = new Parser();
// Cast required due to tree-sitter type version mismatch
parser.setLanguage(Rust);
/**
 * Extract doc comments from a node's preceding siblings
 */
function extractDocComment(node, source) {
    const comments = [];
    let sibling = node.previousNamedSibling;
    // Walk backwards through line comments
    while (sibling) {
        if (sibling.type === 'line_comment') {
            const text = source.slice(sibling.startIndex, sibling.endIndex);
            // Check for /// or //! style doc comments
            if (text.startsWith('///') || text.startsWith('//!')) {
                const content = text.replace(/^\/\/[\/!]\s?/, '');
                comments.unshift(content);
            }
            else {
                break; // Regular comment, stop
            }
        }
        else if (sibling.type === 'block_comment') {
            const text = source.slice(sibling.startIndex, sibling.endIndex);
            if (text.startsWith('/**') || text.startsWith('/*!')) {
                const content = text
                    .replace(/^\/\*[*!]\s?/, '')
                    .replace(/\*\/$/, '')
                    .split('\n')
                    .map((line) => line.replace(/^\s*\*\s?/, ''))
                    .join('\n')
                    .trim();
                comments.unshift(content);
            }
            break;
        }
        else {
            break;
        }
        sibling = sibling.previousNamedSibling;
    }
    return comments.length > 0 ? comments.join('\n') : undefined;
}
/**
 * Extract module-level doc comments (//!)
 */
function extractModuleDoc(tree, source) {
    const comments = [];
    for (const child of tree.rootNode.children) {
        if (child.type === 'line_comment') {
            const text = source.slice(child.startIndex, child.endIndex);
            if (text.startsWith('//!')) {
                comments.push(text.replace(/^\/\/!\s?/, ''));
            }
        }
        else if (child.type === 'block_comment') {
            const text = source.slice(child.startIndex, child.endIndex);
            if (text.startsWith('/*!')) {
                const content = text
                    .replace(/^\/\*!\s?/, '')
                    .replace(/\*\/$/, '')
                    .split('\n')
                    .map((line) => line.replace(/^\s*\*\s?/, ''))
                    .join('\n')
                    .trim();
                comments.push(content);
            }
        }
        else if (child.type !== 'use_declaration' &&
            child.type !== 'attribute_item' &&
            !child.type.includes('comment')) {
            // Stop at first non-comment, non-use, non-attribute item
            break;
        }
    }
    return comments.length > 0 ? comments.join('\n') : undefined;
}
/**
 * Check if a node has pub visibility
 */
function isPublic(node) {
    for (const child of node.children) {
        if (child.type === 'visibility_modifier') {
            const text = child.text;
            return text === 'pub' || text.startsWith('pub(');
        }
    }
    return false;
}
/**
 * Get the visibility text if public
 */
function getVisibility(node) {
    for (const child of node.children) {
        if (child.type === 'visibility_modifier') {
            return child.text;
        }
    }
    return '';
}
/**
 * Extract generics from a node
 */
function extractGenerics(node, source) {
    const typeParams = node.childForFieldName('type_parameters');
    if (typeParams) {
        return source.slice(typeParams.startIndex, typeParams.endIndex);
    }
    return '';
}
/**
 * Extract derive macros from attributes
 */
function extractDerives(node, source) {
    const derives = [];
    let sibling = node.previousNamedSibling;
    while (sibling && sibling.type === 'attribute_item') {
        const text = source.slice(sibling.startIndex, sibling.endIndex);
        const match = text.match(/#\[derive\(([^)]+)\)\]/);
        if (match) {
            derives.push(...match[1].split(',').map((s) => s.trim()));
        }
        sibling = sibling.previousNamedSibling;
    }
    return derives;
}
/**
 * Parse a function signature
 */
function parseFunctionSignature(node, source) {
    const name = node.childForFieldName('name')?.text;
    if (!name)
        return null;
    const pub = isPublic(node);
    const doc = extractDocComment(node, source);
    // Build signature
    const parts = [];
    // Check for unsafe/async
    let isUnsafe = false;
    let isAsync = false;
    for (const child of node.children) {
        if (child.text === 'unsafe')
            isUnsafe = true;
        if (child.text === 'async')
            isAsync = true;
    }
    if (pub)
        parts.push(getVisibility(node));
    if (isUnsafe)
        parts.push('unsafe');
    if (isAsync)
        parts.push('async');
    parts.push('fn');
    parts.push(name);
    const generics = extractGenerics(node, source);
    if (generics)
        parts[parts.length - 1] += generics;
    const params = node.childForFieldName('parameters');
    if (params) {
        parts[parts.length - 1] += source.slice(params.startIndex, params.endIndex);
    }
    const returnType = node.childForFieldName('return_type');
    if (returnType) {
        parts.push('->');
        parts.push(source.slice(returnType.startIndex, returnType.endIndex));
    }
    // Add where clause if present
    const whereClause = node.children.find((c) => c.type === 'where_clause');
    if (whereClause) {
        parts.push(source.slice(whereClause.startIndex, whereClause.endIndex));
    }
    return {
        name,
        doc,
        signature: parts.join(' '),
        isUnsafe,
        isAsync,
        isPublic: pub,
    };
}
/**
 * Parse struct fields
 */
function parseStructFields(node, source) {
    const fields = [];
    const fieldList = node.children.find((c) => c.type === 'field_declaration_list');
    if (!fieldList)
        return fields;
    for (const child of fieldList.namedChildren) {
        if (child.type === 'field_declaration') {
            const name = child.childForFieldName('name')?.text;
            const type = child.childForFieldName('type');
            if (name && type) {
                fields.push({
                    name,
                    type: source.slice(type.startIndex, type.endIndex),
                    doc: extractDocComment(child, source),
                    isPublic: isPublic(child),
                });
            }
        }
    }
    return fields;
}
/**
 * Parse a struct definition
 */
function parseStruct(node, source) {
    const name = node.childForFieldName('name')?.text;
    if (!name)
        return null;
    return {
        name,
        doc: extractDocComment(node, source),
        generics: extractGenerics(node, source),
        fields: parseStructFields(node, source),
        methods: [], // Filled in by impl block parsing
        derives: extractDerives(node, source),
    };
}
/**
 * Parse enum variants
 */
function parseEnumVariants(node, source) {
    const variants = [];
    const body = node.children.find((c) => c.type === 'enum_variant_list');
    if (!body)
        return variants;
    for (const child of body.namedChildren) {
        if (child.type === 'enum_variant') {
            const name = child.childForFieldName('name')?.text;
            if (name) {
                // Include field info for tuple/struct variants
                const fields = child.children.find((c) => c.type === 'field_declaration_list' ||
                    c.type === 'ordered_field_declaration_list');
                if (fields) {
                    variants.push(`${name}${source.slice(fields.startIndex, fields.endIndex)}`);
                }
                else {
                    variants.push(name);
                }
            }
        }
    }
    return variants;
}
/**
 * Parse an enum definition
 */
function parseEnum(node, source) {
    const name = node.childForFieldName('name')?.text;
    if (!name)
        return null;
    return {
        name,
        doc: extractDocComment(node, source),
        generics: extractGenerics(node, source),
        variants: parseEnumVariants(node, source),
        derives: extractDerives(node, source),
    };
}
/**
 * Parse a trait definition
 */
function parseTrait(node, source) {
    const name = node.childForFieldName('name')?.text;
    if (!name)
        return null;
    const methods = [];
    const body = node.children.find((c) => c.type === 'declaration_list');
    if (body) {
        for (const child of body.namedChildren) {
            if (child.type === 'function_item' || child.type === 'function_signature_item') {
                const fn = parseFunctionSignature(child, source);
                if (fn)
                    methods.push(fn);
            }
        }
    }
    // Extract bounds (supertraits)
    let bounds = '';
    const boundsNode = node.children.find((c) => c.type === 'trait_bounds');
    if (boundsNode) {
        // Remove the leading `:` since we add it in formatting
        bounds = source.slice(boundsNode.startIndex, boundsNode.endIndex).replace(/^:\s*/, '');
    }
    return {
        name,
        doc: extractDocComment(node, source),
        generics: extractGenerics(node, source),
        bounds,
        methods,
    };
}
/**
 * Parse a type alias
 */
function parseTypeAlias(node, source) {
    const name = node.childForFieldName('name')?.text;
    const type = node.childForFieldName('type');
    if (!name || !type)
        return null;
    const generics = extractGenerics(node, source);
    return {
        name,
        doc: extractDocComment(node, source),
        definition: `type ${name}${generics} = ${source.slice(type.startIndex, type.endIndex)};`,
    };
}
/**
 * Parse a const or static item
 */
function parseConstant(node, source, isStatic) {
    const name = node.childForFieldName('name')?.text;
    const type = node.childForFieldName('type');
    if (!name || !type)
        return null;
    return {
        name,
        doc: extractDocComment(node, source),
        type: source.slice(type.startIndex, type.endIndex),
        isStatic,
    };
}
/**
 * Parse an impl block and add methods to the appropriate struct/trait
 */
function parseImplBlock(node, source, structMap) {
    // Get the type being implemented
    const type = node.childForFieldName('type');
    if (!type)
        return;
    // Check if this is a trait impl
    const trait = node.childForFieldName('trait');
    if (trait) {
        // Skip trait impls - we already have the trait methods
        return;
    }
    const typeName = type.text.split('<')[0]; // Handle generics
    const struct = structMap.get(typeName);
    if (!struct)
        return;
    const body = node.children.find((c) => c.type === 'declaration_list');
    if (!body)
        return;
    for (const child of body.namedChildren) {
        if (child.type === 'function_item') {
            const fn = parseFunctionSignature(child, source);
            if (fn && fn.isPublic) {
                struct.methods.push(fn);
            }
        }
    }
}
/**
 * Parse a use declaration for re-exports
 */
function parseReexport(node, source) {
    if (!isPublic(node))
        return null;
    return source.slice(node.startIndex, node.endIndex);
}
/**
 * Parse Rust source code and extract public interface
 */
export function parseRust(source) {
    try {
        const tree = parser.parse(source);
        const structMap = new Map();
        const summary = {
            purpose: extractModuleDoc(tree, source),
            structs: [],
            traits: [],
            enums: [],
            functions: [],
            typeAliases: [],
            constants: [],
            reexports: [],
        };
        // First pass: collect all items except impl blocks
        for (const node of tree.rootNode.namedChildren) {
            switch (node.type) {
                case 'struct_item':
                    if (isPublic(node)) {
                        const struct = parseStruct(node, source);
                        if (struct) {
                            summary.structs.push(struct);
                            structMap.set(struct.name, struct);
                        }
                    }
                    break;
                case 'enum_item':
                    if (isPublic(node)) {
                        const enumDef = parseEnum(node, source);
                        if (enumDef)
                            summary.enums.push(enumDef);
                    }
                    break;
                case 'trait_item':
                    if (isPublic(node)) {
                        const trait = parseTrait(node, source);
                        if (trait)
                            summary.traits.push(trait);
                    }
                    break;
                case 'function_item':
                    if (isPublic(node)) {
                        const fn = parseFunctionSignature(node, source);
                        if (fn)
                            summary.functions.push(fn);
                    }
                    break;
                case 'type_item':
                    if (isPublic(node)) {
                        const alias = parseTypeAlias(node, source);
                        if (alias)
                            summary.typeAliases.push(alias);
                    }
                    break;
                case 'const_item':
                    if (isPublic(node)) {
                        const constant = parseConstant(node, source, false);
                        if (constant)
                            summary.constants.push(constant);
                    }
                    break;
                case 'static_item':
                    if (isPublic(node)) {
                        const staticItem = parseConstant(node, source, true);
                        if (staticItem)
                            summary.constants.push(staticItem);
                    }
                    break;
                case 'use_declaration':
                    const reexport = parseReexport(node, source);
                    if (reexport)
                        summary.reexports.push(reexport);
                    break;
            }
        }
        // Second pass: process impl blocks
        for (const node of tree.rootNode.namedChildren) {
            if (node.type === 'impl_item') {
                parseImplBlock(node, source, structMap);
            }
        }
        return {
            success: true,
            summary,
            formattedSummary: formatSummary(summary),
        };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
/**
 * Format a summary into human-readable text
 */
function formatSummary(summary) {
    const lines = [];
    // Purpose
    if (summary.purpose) {
        // Format multi-line purpose comments properly
        const purposeLines = summary.purpose.split('\n').filter(l => l.trim());
        lines.push(`// Purpose: ${purposeLines[0]}`);
        for (let i = 1; i < purposeLines.length; i++) {
            lines.push(`//          ${purposeLines[i]}`);
        }
        lines.push('');
    }
    // Re-exports
    if (summary.reexports.length > 0) {
        for (const reexport of summary.reexports) {
            lines.push(reexport);
        }
        lines.push('');
    }
    // Constants
    for (const constant of summary.constants) {
        if (constant.doc) {
            lines.push(`/// ${constant.doc.split('\n')[0]}`);
        }
        const keyword = constant.isStatic ? 'static' : 'const';
        lines.push(`pub ${keyword} ${constant.name}: ${constant.type};`);
    }
    if (summary.constants.length > 0)
        lines.push('');
    // Type aliases
    for (const alias of summary.typeAliases) {
        if (alias.doc) {
            lines.push(`/// ${alias.doc.split('\n')[0]}`);
        }
        lines.push(`pub ${alias.definition}`);
    }
    if (summary.typeAliases.length > 0)
        lines.push('');
    // Structs
    for (const struct of summary.structs) {
        if (struct.derives.length > 0) {
            lines.push(`#[derive(${struct.derives.join(', ')})]`);
        }
        if (struct.doc) {
            lines.push(`/// ${struct.doc.split('\n')[0]}`);
        }
        lines.push(`pub struct ${struct.name}${struct.generics} { ... }`);
        // Public fields
        const pubFields = struct.fields.filter((f) => f.isPublic);
        if (pubFields.length > 0) {
            lines.push('  // Public fields:');
            for (const field of pubFields) {
                lines.push(`  pub ${field.name}: ${field.type},`);
            }
        }
        // Methods
        if (struct.methods.length > 0) {
            lines.push(`impl${struct.generics} ${struct.name}${struct.generics} {`);
            for (const method of struct.methods) {
                lines.push(`    ${method.signature};`);
            }
            lines.push('}');
        }
        lines.push('');
    }
    // Enums
    for (const enumDef of summary.enums) {
        if (enumDef.derives.length > 0) {
            lines.push(`#[derive(${enumDef.derives.join(', ')})]`);
        }
        if (enumDef.doc) {
            lines.push(`/// ${enumDef.doc.split('\n')[0]}`);
        }
        lines.push(`pub enum ${enumDef.name}${enumDef.generics} {`);
        for (const variant of enumDef.variants) {
            lines.push(`    ${variant},`);
        }
        lines.push('}');
        lines.push('');
    }
    // Traits
    for (const trait of summary.traits) {
        if (trait.doc) {
            lines.push(`/// ${trait.doc.split('\n')[0]}`);
        }
        let header = `pub trait ${trait.name}${trait.generics}`;
        if (trait.bounds) {
            header += `: ${trait.bounds}`;
        }
        lines.push(`${header} {`);
        for (const method of trait.methods) {
            lines.push(`    ${method.signature};`);
        }
        lines.push('}');
        lines.push('');
    }
    // Standalone functions
    for (const fn of summary.functions) {
        if (fn.doc) {
            lines.push(`/// ${fn.doc.split('\n')[0]}`);
        }
        lines.push(`${fn.signature};`);
    }
    return lines.join('\n').trim();
}
/**
 * Check if this parser supports the given file extension
 */
export function supportsExtension(ext) {
    return ext === '.rs';
}
//# sourceMappingURL=rust.js.map