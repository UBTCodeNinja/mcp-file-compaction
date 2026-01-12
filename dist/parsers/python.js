import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
const parser = new Parser();
parser.setLanguage(Python);
/**
 * Check if a name is public (doesn't start with underscore)
 */
function isPublicName(name) {
    return !name.startsWith('_');
}
/**
 * Extract docstring from a function or class body
 */
function extractDocstring(node, source) {
    // Look for expression_statement containing a string as first child of block
    const body = node.childForFieldName('body');
    if (!body)
        return undefined;
    const firstChild = body.namedChildren[0];
    if (!firstChild)
        return undefined;
    if (firstChild.type === 'expression_statement') {
        const expr = firstChild.namedChildren[0];
        if (expr && expr.type === 'string') {
            const text = source.slice(expr.startIndex, expr.endIndex);
            // Remove quotes and clean up
            return text
                .replace(/^['"`]{3}|['"`]{3}$/g, '')
                .replace(/^['"`]|['"`]$/g, '')
                .trim();
        }
    }
    return undefined;
}
/**
 * Extract module-level docstring
 */
function extractModuleDoc(tree, source) {
    const firstChild = tree.rootNode.namedChildren[0];
    if (!firstChild)
        return undefined;
    if (firstChild.type === 'expression_statement') {
        const expr = firstChild.namedChildren[0];
        if (expr && expr.type === 'string') {
            const text = source.slice(expr.startIndex, expr.endIndex);
            return text
                .replace(/^['"`]{3}|['"`]{3}$/g, '')
                .replace(/^['"`]|['"`]$/g, '')
                .trim();
        }
    }
    return undefined;
}
/**
 * Extract decorators from a function or class
 */
function extractDecorators(node, source) {
    const decorators = [];
    // In tree-sitter-python, decorators are part of decorated_definition
    // or they can be siblings before the node
    if (node.parent?.type === 'decorated_definition') {
        for (const child of node.parent.namedChildren) {
            if (child.type === 'decorator') {
                decorators.push(source.slice(child.startIndex, child.endIndex));
            }
        }
    }
    return decorators;
}
/**
 * Parse function parameters into a signature string
 */
function parseFunctionSignature(node, source) {
    const name = node.childForFieldName('name')?.text || '';
    const params = node.childForFieldName('parameters');
    const returnType = node.childForFieldName('return_type');
    let sig = `def ${name}`;
    if (params) {
        sig += source.slice(params.startIndex, params.endIndex);
    }
    else {
        sig += '()';
    }
    if (returnType) {
        sig += ` -> ${source.slice(returnType.startIndex, returnType.endIndex)}`;
    }
    return sig;
}
/**
 * Parse a function definition
 */
function parseFunction(node, source) {
    const name = node.childForFieldName('name')?.text;
    if (!name || !isPublicName(name))
        return null;
    const isAsync = node.type === 'async_function_definition' ||
        node.parent?.type === 'async_function_definition';
    return {
        name,
        doc: extractDocstring(node, source),
        signature: parseFunctionSignature(node, source),
        isUnsafe: false,
        isAsync,
        isPublic: true,
    };
}
/**
 * Parse class fields from __init__ method and class body
 */
function parseClassFields(node, source) {
    const fields = [];
    const body = node.childForFieldName('body');
    if (!body)
        return fields;
    // Look for class-level type annotations
    for (const child of body.namedChildren) {
        if (child.type === 'expression_statement') {
            const expr = child.namedChildren[0];
            // Handle: name: type or name: type = value
            if (expr?.type === 'assignment' || expr?.type === 'type') {
                const left = expr.childForFieldName('left') || expr.namedChildren[0];
                if (left?.type === 'identifier') {
                    const name = left.text;
                    if (isPublicName(name)) {
                        const typeNode = expr.childForFieldName('type') || expr.namedChildren[1];
                        fields.push({
                            name,
                            type: typeNode ? source.slice(typeNode.startIndex, typeNode.endIndex) : 'Any',
                            isPublic: true,
                        });
                    }
                }
            }
        }
        else if (child.type === 'annotated_assignment') {
            const name = child.childForFieldName('left')?.text;
            const typeNode = child.childForFieldName('type');
            if (name && isPublicName(name)) {
                fields.push({
                    name,
                    type: typeNode ? source.slice(typeNode.startIndex, typeNode.endIndex) : 'Any',
                    isPublic: true,
                });
            }
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
        let funcNode = child;
        // Handle decorated methods
        if (child.type === 'decorated_definition') {
            funcNode = child.namedChildren.find(c => c.type === 'function_definition' || c.type === 'async_function_definition') || child;
        }
        if (funcNode.type === 'function_definition' || funcNode.type === 'async_function_definition') {
            const fn = parseFunction(funcNode, source);
            if (fn) {
                const decorators = extractDecorators(funcNode, source);
                // Include decorator info in signature if present
                if (decorators.length > 0) {
                    fn.signature = decorators.join('\n') + '\n' + fn.signature;
                }
                methods.push(fn);
            }
        }
    }
    return methods;
}
/**
 * Parse a class definition
 */
function parseClass(node, source) {
    const name = node.childForFieldName('name')?.text;
    if (!name || !isPublicName(name))
        return null;
    // Get base classes
    const superclass = node.childForFieldName('superclasses');
    let generics = '';
    if (superclass) {
        generics = source.slice(superclass.startIndex, superclass.endIndex);
    }
    return {
        name,
        doc: extractDocstring(node, source),
        generics,
        fields: parseClassFields(node, source),
        methods: parseClassMethods(node, source),
        derives: extractDecorators(node, source),
    };
}
/**
 * Check if a node is a constant (UPPER_CASE assignment at module level)
 */
function isConstant(name) {
    return /^[A-Z][A-Z0-9_]*$/.test(name);
}
/**
 * Parse a module-level constant or type alias
 */
function parseModuleLevelAssignment(node, source) {
    const result = {};
    let name;
    let typeStr;
    if (node.type === 'assignment') {
        const left = node.childForFieldName('left');
        if (left?.type === 'identifier') {
            name = left.text;
        }
        const type = node.childForFieldName('type');
        if (type) {
            typeStr = source.slice(type.startIndex, type.endIndex);
        }
    }
    else if (node.type === 'annotated_assignment') {
        name = node.childForFieldName('left')?.text;
        const type = node.childForFieldName('type');
        if (type) {
            typeStr = source.slice(type.startIndex, type.endIndex);
        }
    }
    if (!name || !isPublicName(name))
        return result;
    // Check if this is a TypeAlias
    if (typeStr === 'TypeAlias' || typeStr?.includes('TypeAlias')) {
        const right = node.childForFieldName('right');
        if (right) {
            result.typeAlias = {
                name,
                definition: `${name} = ${source.slice(right.startIndex, right.endIndex)}`,
            };
        }
    }
    else if (isConstant(name)) {
        result.constant = {
            name,
            type: typeStr || 'Any',
            isStatic: false,
        };
    }
    return result;
}
/**
 * Parse Python source code and extract public interface
 */
export function parsePython(source) {
    try {
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
        for (const node of tree.rootNode.namedChildren) {
            switch (node.type) {
                case 'class_definition': {
                    const cls = parseClass(node, source);
                    if (cls)
                        summary.structs.push(cls);
                    break;
                }
                case 'decorated_definition': {
                    // Find the actual definition inside
                    const innerDef = node.namedChildren.find(c => c.type === 'class_definition' ||
                        c.type === 'function_definition' ||
                        c.type === 'async_function_definition');
                    if (innerDef?.type === 'class_definition') {
                        const cls = parseClass(innerDef, source);
                        if (cls)
                            summary.structs.push(cls);
                    }
                    else if (innerDef?.type === 'function_definition' ||
                        innerDef?.type === 'async_function_definition') {
                        const fn = parseFunction(innerDef, source);
                        if (fn) {
                            const decorators = extractDecorators(innerDef, source);
                            if (decorators.length > 0) {
                                fn.signature = decorators.join('\n') + '\n' + fn.signature;
                            }
                            summary.functions.push(fn);
                        }
                    }
                    break;
                }
                case 'function_definition':
                case 'async_function_definition': {
                    const fn = parseFunction(node, source);
                    if (fn)
                        summary.functions.push(fn);
                    break;
                }
                case 'expression_statement': {
                    const expr = node.namedChildren[0];
                    if (expr?.type === 'assignment' || expr?.type === 'annotated_assignment') {
                        const { constant, typeAlias } = parseModuleLevelAssignment(expr, source);
                        if (constant)
                            summary.constants.push(constant);
                        if (typeAlias)
                            summary.typeAliases.push(typeAlias);
                    }
                    break;
                }
                case 'annotated_assignment': {
                    const { constant, typeAlias } = parseModuleLevelAssignment(node, source);
                    if (constant)
                        summary.constants.push(constant);
                    if (typeAlias)
                        summary.typeAliases.push(typeAlias);
                    break;
                }
                // Handle __all__ exports as reexports indicator
                case 'assignment': {
                    const left = node.childForFieldName('left');
                    if (left?.text === '__all__') {
                        const right = node.childForFieldName('right');
                        if (right) {
                            summary.reexports.push(source.slice(node.startIndex, node.endIndex));
                        }
                    }
                    break;
                }
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
 * Format a summary into human-readable Python-style text
 */
function formatSummary(summary) {
    const lines = [];
    // Module docstring
    if (summary.purpose) {
        lines.push(`"""${summary.purpose}"""`);
        lines.push('');
    }
    // Exports
    if (summary.reexports.length > 0) {
        for (const reexport of summary.reexports) {
            lines.push(reexport);
        }
        lines.push('');
    }
    // Constants
    for (const constant of summary.constants) {
        lines.push(`${constant.name}: ${constant.type}`);
    }
    if (summary.constants.length > 0)
        lines.push('');
    // Type aliases
    for (const alias of summary.typeAliases) {
        lines.push(alias.definition);
    }
    if (summary.typeAliases.length > 0)
        lines.push('');
    // Classes
    for (const cls of summary.structs) {
        // Decorators
        for (const dec of cls.derives) {
            lines.push(dec);
        }
        // Class declaration
        let header = `class ${cls.name}`;
        if (cls.generics) {
            header += cls.generics;
        }
        header += ':';
        lines.push(header);
        // Docstring
        if (cls.doc) {
            lines.push(`    """${cls.doc.split('\n')[0]}"""`);
        }
        // Fields
        if (cls.fields.length > 0) {
            for (const field of cls.fields) {
                lines.push(`    ${field.name}: ${field.type}`);
            }
        }
        // Methods
        for (const method of cls.methods) {
            const sigLines = method.signature.split('\n');
            for (const sigLine of sigLines) {
                lines.push(`    ${sigLine}`);
            }
            lines.push('        ...');
        }
        if (cls.fields.length === 0 && cls.methods.length === 0) {
            lines.push('    ...');
        }
        lines.push('');
    }
    // Standalone functions
    for (const fn of summary.functions) {
        if (fn.doc) {
            lines.push(`# ${fn.doc.split('\n')[0]}`);
        }
        const sigLines = fn.signature.split('\n');
        for (const sigLine of sigLines) {
            lines.push(sigLine);
        }
        lines.push('    ...');
        lines.push('');
    }
    return lines.join('\n').trim();
}
/**
 * Check if this parser supports the given file extension
 */
export function supportsExtension(ext) {
    return ext === '.py';
}
//# sourceMappingURL=python.js.map