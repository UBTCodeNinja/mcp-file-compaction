import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
// TypeScript grammar provides both typescript and tsx
const tsParser = new Parser();
tsParser.setLanguage(TypeScript.typescript);
const tsxParser = new Parser();
tsxParser.setLanguage(TypeScript.tsx);
/**
 * Get the appropriate parser for a file extension
 */
function getParser(ext) {
    return ext === '.tsx' || ext === '.jsx' ? tsxParser : tsParser;
}
/**
 * Extract JSDoc comment from preceding siblings
 */
function extractJSDoc(node, source) {
    let sibling = node.previousNamedSibling;
    while (sibling) {
        if (sibling.type === 'comment') {
            const text = source.slice(sibling.startIndex, sibling.endIndex);
            // Check for JSDoc style /** ... */
            if (text.startsWith('/**')) {
                return text
                    .replace(/^\/\*\*\s?/, '')
                    .replace(/\*\/$/, '')
                    .split('\n')
                    .map(line => line.replace(/^\s*\*\s?/, ''))
                    .join('\n')
                    .trim();
            }
        }
        else {
            break;
        }
        sibling = sibling.previousNamedSibling;
    }
    return undefined;
}
/**
 * Extract module-level doc comment (first JSDoc in file)
 */
function extractModuleDoc(tree, source) {
    const firstChild = tree.rootNode.namedChildren[0];
    if (!firstChild)
        return undefined;
    if (firstChild.type === 'comment') {
        const text = source.slice(firstChild.startIndex, firstChild.endIndex);
        if (text.startsWith('/**')) {
            return text
                .replace(/^\/\*\*\s?/, '')
                .replace(/\*\/$/, '')
                .split('\n')
                .map(line => line.replace(/^\s*\*\s?/, ''))
                .join('\n')
                .trim();
        }
    }
    return undefined;
}
/**
 * Check if a node is exported
 */
function isExported(node) {
    // Check if this is inside an export statement
    if (node.parent?.type === 'export_statement') {
        return true;
    }
    // Check for export keyword in the node itself
    for (const child of node.children) {
        if (child.text === 'export')
            return true;
    }
    return false;
}
/**
 * Check if this is a default export
 */
function isDefaultExport(node) {
    if (node.parent?.type === 'export_statement') {
        for (const child of node.parent.children) {
            if (child.text === 'default')
                return true;
        }
    }
    return false;
}
/**
 * Extract type parameters (generics)
 */
function extractGenerics(node, source) {
    const typeParams = node.childForFieldName('type_parameters');
    if (typeParams) {
        return source.slice(typeParams.startIndex, typeParams.endIndex);
    }
    return '';
}
/**
 * Parse a function signature
 */
function parseFunctionSignature(node, source, isMethod = false) {
    const name = node.childForFieldName('name')?.text;
    if (!name)
        return null;
    const parts = [];
    // Check for async
    let isAsync = false;
    for (const child of node.children) {
        if (child.text === 'async') {
            isAsync = true;
            parts.push('async');
            break;
        }
    }
    // Check for static (methods)
    let isStatic = false;
    for (const child of node.children) {
        if (child.text === 'static') {
            isStatic = true;
            break;
        }
    }
    if (!isMethod) {
        parts.push('function');
    }
    if (isStatic) {
        parts.unshift('static');
    }
    parts.push(name);
    const generics = extractGenerics(node, source);
    if (generics) {
        parts[parts.length - 1] += generics;
    }
    const params = node.childForFieldName('parameters');
    if (params) {
        parts[parts.length - 1] += source.slice(params.startIndex, params.endIndex);
    }
    const returnType = node.childForFieldName('return_type');
    if (returnType) {
        parts[parts.length - 1] += ': ' + source.slice(returnType.startIndex, returnType.endIndex);
    }
    return {
        name,
        doc: extractJSDoc(node, source),
        signature: parts.join(' '),
        isUnsafe: false,
        isAsync,
        isPublic: true,
    };
}
/**
 * Parse class fields/properties
 */
function parseClassFields(node, source) {
    const fields = [];
    const body = node.childForFieldName('body');
    if (!body)
        return fields;
    for (const child of body.namedChildren) {
        if (child.type === 'public_field_definition' ||
            child.type === 'property_signature' ||
            child.type === 'field_definition') {
            const name = child.childForFieldName('name')?.text;
            const typeNode = child.childForFieldName('type');
            // Skip private fields (start with # or have private modifier)
            if (!name || name.startsWith('#'))
                continue;
            let isPublic = true;
            for (const c of child.children) {
                if (c.text === 'private' || c.text === 'protected') {
                    isPublic = false;
                    break;
                }
            }
            if (!isPublic)
                continue;
            fields.push({
                name,
                type: typeNode ? source.slice(typeNode.startIndex, typeNode.endIndex) : 'any',
                doc: extractJSDoc(child, source),
                isPublic: true,
            });
        }
    }
    return fields;
}
/**
 * Parse class methods
 */
function parseClassMethods(node, source) {
    const methods = [];
    const body = node.childForFieldName('body');
    if (!body)
        return methods;
    for (const child of body.namedChildren) {
        if (child.type === 'method_definition' ||
            child.type === 'method_signature') {
            // Skip private methods
            let isPublic = true;
            let name = child.childForFieldName('name')?.text;
            if (!name || name.startsWith('#'))
                continue;
            for (const c of child.children) {
                if (c.text === 'private' || c.text === 'protected') {
                    isPublic = false;
                    break;
                }
            }
            if (!isPublic)
                continue;
            const fn = parseFunctionSignature(child, source, true);
            if (fn)
                methods.push(fn);
        }
    }
    return methods;
}
/**
 * Parse a class definition
 */
function parseClass(node, source) {
    const name = node.childForFieldName('name')?.text;
    if (!name)
        return null;
    // Get extends/implements
    let generics = extractGenerics(node, source);
    const heritage = node.children.find(c => c.type === 'class_heritage');
    if (heritage) {
        generics += (generics ? ' ' : '') + source.slice(heritage.startIndex, heritage.endIndex);
    }
    return {
        name,
        doc: extractJSDoc(node, source),
        generics,
        fields: parseClassFields(node, source),
        methods: parseClassMethods(node, source),
        derives: [], // TypeScript doesn't have decorators in the same way
    };
}
/**
 * Parse an interface definition
 */
function parseInterface(node, source) {
    const name = node.childForFieldName('name')?.text;
    if (!name)
        return null;
    const methods = [];
    const body = node.childForFieldName('body');
    if (body) {
        for (const child of body.namedChildren) {
            if (child.type === 'method_signature' || child.type === 'call_signature') {
                const methodName = child.childForFieldName('name')?.text;
                if (!methodName)
                    continue;
                const params = child.childForFieldName('parameters');
                const returnType = child.childForFieldName('return_type');
                let sig = methodName;
                const generics = extractGenerics(child, source);
                if (generics)
                    sig += generics;
                if (params)
                    sig += source.slice(params.startIndex, params.endIndex);
                if (returnType)
                    sig += ': ' + source.slice(returnType.startIndex, returnType.endIndex);
                methods.push({
                    name: methodName,
                    doc: extractJSDoc(child, source),
                    signature: sig,
                    isUnsafe: false,
                    isAsync: false,
                    isPublic: true,
                });
            }
            else if (child.type === 'property_signature') {
                // Include property signatures as methods for interface summary
                const propName = child.childForFieldName('name')?.text;
                const typeNode = child.childForFieldName('type');
                if (propName && typeNode) {
                    methods.push({
                        name: propName,
                        doc: extractJSDoc(child, source),
                        signature: `${propName}: ${source.slice(typeNode.startIndex, typeNode.endIndex)}`,
                        isUnsafe: false,
                        isAsync: false,
                        isPublic: true,
                    });
                }
            }
        }
    }
    // Get extends
    let bounds = '';
    const heritage = node.children.find(c => c.type === 'extends_type_clause');
    if (heritage) {
        bounds = source.slice(heritage.startIndex, heritage.endIndex).replace(/^extends\s+/, '');
    }
    return {
        name,
        doc: extractJSDoc(node, source),
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
    const value = node.childForFieldName('value');
    if (!name || !value)
        return null;
    const generics = extractGenerics(node, source);
    return {
        name,
        doc: extractJSDoc(node, source),
        definition: `type ${name}${generics} = ${source.slice(value.startIndex, value.endIndex)}`,
    };
}
/**
 * Parse an enum declaration
 */
function parseEnum(node, source) {
    const name = node.childForFieldName('name')?.text;
    if (!name)
        return null;
    const variants = [];
    const body = node.childForFieldName('body');
    if (body) {
        for (const child of body.namedChildren) {
            if (child.type === 'enum_assignment' || child.type === 'property_identifier') {
                const memberName = child.childForFieldName('name')?.text || child.text;
                if (memberName) {
                    const value = child.childForFieldName('value');
                    if (value) {
                        variants.push(`${memberName} = ${source.slice(value.startIndex, value.endIndex)}`);
                    }
                    else {
                        variants.push(memberName);
                    }
                }
            }
        }
    }
    return {
        name,
        variants,
        doc: extractJSDoc(node, source),
    };
}
/**
 * Parse TypeScript/JavaScript source code
 */
export function parseTypeScript(source, ext = '.ts') {
    try {
        const parser = getParser(ext);
        const tree = parser.parse(source);
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
        function processNode(node, exported = false) {
            switch (node.type) {
                case 'export_statement': {
                    // Process the exported declaration
                    const declaration = node.childForFieldName('declaration');
                    if (declaration) {
                        processNode(declaration, true);
                    }
                    // Handle re-exports: export { ... } from '...'
                    const source_text = source.slice(node.startIndex, node.endIndex);
                    if (source_text.includes(' from ')) {
                        summary.reexports.push(source_text);
                    }
                    break;
                }
                case 'class_declaration': {
                    if (exported || isExported(node)) {
                        const cls = parseClass(node, source);
                        if (cls)
                            summary.structs.push(cls);
                    }
                    break;
                }
                case 'interface_declaration':
                case 'abstract_class_declaration': {
                    if (exported || isExported(node)) {
                        const iface = parseInterface(node, source);
                        if (iface)
                            summary.traits.push(iface);
                    }
                    break;
                }
                case 'type_alias_declaration': {
                    if (exported || isExported(node)) {
                        const alias = parseTypeAlias(node, source);
                        if (alias)
                            summary.typeAliases.push(alias);
                    }
                    break;
                }
                case 'enum_declaration': {
                    if (exported || isExported(node)) {
                        const enumDef = parseEnum(node, source);
                        if (enumDef) {
                            summary.enums.push({
                                name: enumDef.name,
                                doc: enumDef.doc,
                                generics: '',
                                variants: enumDef.variants,
                                derives: [],
                            });
                        }
                    }
                    break;
                }
                case 'function_declaration':
                case 'function_signature': {
                    if (exported || isExported(node)) {
                        const fn = parseFunctionSignature(node, source);
                        if (fn)
                            summary.functions.push(fn);
                    }
                    break;
                }
                case 'lexical_declaration':
                case 'variable_declaration': {
                    if (exported || isExported(node)) {
                        // Handle: export const foo = ...
                        for (const declarator of node.namedChildren) {
                            if (declarator.type === 'variable_declarator') {
                                const name = declarator.childForFieldName('name')?.text;
                                const typeNode = declarator.childForFieldName('type');
                                const value = declarator.childForFieldName('value');
                                if (!name)
                                    continue;
                                // Check if it's an arrow function
                                if (value?.type === 'arrow_function') {
                                    const params = value.childForFieldName('parameters');
                                    const returnType = value.childForFieldName('return_type');
                                    let sig = `const ${name}`;
                                    if (params)
                                        sig += ' = ' + source.slice(params.startIndex, params.endIndex);
                                    else
                                        sig += ' = ()';
                                    sig += ' =>';
                                    if (returnType)
                                        sig += ' ' + source.slice(returnType.startIndex, returnType.endIndex);
                                    summary.functions.push({
                                        name,
                                        doc: extractJSDoc(node, source),
                                        signature: sig,
                                        isUnsafe: false,
                                        isAsync: value.children.some(c => c.text === 'async'),
                                        isPublic: true,
                                    });
                                }
                                else {
                                    // Regular constant
                                    summary.constants.push({
                                        name,
                                        doc: extractJSDoc(node, source),
                                        type: typeNode ? source.slice(typeNode.startIndex, typeNode.endIndex) : 'any',
                                        isStatic: false,
                                    });
                                }
                            }
                        }
                    }
                    break;
                }
            }
        }
        for (const node of tree.rootNode.namedChildren) {
            processNode(node);
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
 * Format a summary into human-readable TypeScript-style text
 */
function formatSummary(summary) {
    const lines = [];
    // Module doc
    if (summary.purpose) {
        lines.push(`/**`);
        for (const line of summary.purpose.split('\n')) {
            lines.push(` * ${line}`);
        }
        lines.push(` */`);
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
            lines.push(`/** ${constant.doc.split('\n')[0]} */`);
        }
        lines.push(`export const ${constant.name}: ${constant.type};`);
    }
    if (summary.constants.length > 0)
        lines.push('');
    // Type aliases
    for (const alias of summary.typeAliases) {
        if (alias.doc) {
            lines.push(`/** ${alias.doc.split('\n')[0]} */`);
        }
        lines.push(`export ${alias.definition};`);
    }
    if (summary.typeAliases.length > 0)
        lines.push('');
    // Enums
    for (const enumDef of summary.enums) {
        if (enumDef.doc) {
            lines.push(`/** ${enumDef.doc.split('\n')[0]} */`);
        }
        lines.push(`export enum ${enumDef.name} {`);
        for (const variant of enumDef.variants) {
            lines.push(`  ${variant},`);
        }
        lines.push('}');
        lines.push('');
    }
    // Interfaces
    for (const iface of summary.traits) {
        if (iface.doc) {
            lines.push(`/** ${iface.doc.split('\n')[0]} */`);
        }
        let header = `export interface ${iface.name}${iface.generics}`;
        if (iface.bounds) {
            header += ` extends ${iface.bounds}`;
        }
        lines.push(`${header} {`);
        for (const method of iface.methods) {
            lines.push(`  ${method.signature};`);
        }
        lines.push('}');
        lines.push('');
    }
    // Classes
    for (const cls of summary.structs) {
        if (cls.doc) {
            lines.push(`/** ${cls.doc.split('\n')[0]} */`);
        }
        let header = `export class ${cls.name}`;
        if (cls.generics) {
            header += ` ${cls.generics}`;
        }
        lines.push(`${header} {`);
        // Fields
        for (const field of cls.fields) {
            lines.push(`  ${field.name}: ${field.type};`);
        }
        // Methods
        for (const method of cls.methods) {
            lines.push(`  ${method.signature};`);
        }
        lines.push('}');
        lines.push('');
    }
    // Functions
    for (const fn of summary.functions) {
        if (fn.doc) {
            lines.push(`/** ${fn.doc.split('\n')[0]} */`);
        }
        lines.push(`export ${fn.signature};`);
    }
    return lines.join('\n').trim();
}
/**
 * Check if this parser supports the given file extension
 */
export function supportsExtension(ext) {
    return ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx';
}
//# sourceMappingURL=typescript.js.map