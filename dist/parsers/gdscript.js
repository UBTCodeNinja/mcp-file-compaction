import Parser from 'tree-sitter';
import GDScript from 'tree-sitter-gdscript';
const parser = new Parser();
parser.setLanguage(GDScript);
/**
 * Check if a name is public (doesn't start with underscore)
 */
function isPublicName(name) {
    return !name.startsWith('_');
}
/**
 * Extract doc comment (## style) from preceding siblings
 */
function extractDocComment(node, source) {
    const comments = [];
    let sibling = node.previousNamedSibling;
    while (sibling) {
        if (sibling.type === 'comment') {
            const text = source.slice(sibling.startIndex, sibling.endIndex);
            // GDScript uses ## for doc comments
            if (text.startsWith('##')) {
                comments.unshift(text.replace(/^##\s?/, ''));
            }
            else {
                break;
            }
        }
        else {
            break;
        }
        sibling = sibling.previousNamedSibling;
    }
    return comments.length > 0 ? comments.join('\n') : undefined;
}
/**
 * Extract class docstring (first ## comment at top of file)
 */
function extractClassDoc(tree, source) {
    const comments = [];
    for (const child of tree.rootNode.children) {
        if (child.type === 'comment') {
            const text = source.slice(child.startIndex, child.endIndex);
            if (text.startsWith('##')) {
                comments.push(text.replace(/^##\s?/, ''));
            }
        }
        else if (child.type !== 'annotation') {
            break;
        }
    }
    return comments.length > 0 ? comments.join('\n') : undefined;
}
/**
 * Extract annotations (@export, @onready, etc.)
 */
function extractAnnotations(node, source) {
    const annotations = [];
    let sibling = node.previousNamedSibling;
    while (sibling) {
        if (sibling.type === 'annotation') {
            annotations.unshift(source.slice(sibling.startIndex, sibling.endIndex));
        }
        else if (sibling.type !== 'comment') {
            break;
        }
        sibling = sibling.previousNamedSibling;
    }
    return annotations;
}
/**
 * Parse a function signature
 */
function parseFunctionSignature(node, source) {
    const name = node.childForFieldName('name')?.text;
    if (!name || !isPublicName(name))
        return null;
    const parts = ['func'];
    parts.push(name);
    // Parameters
    const params = node.childForFieldName('parameters');
    if (params) {
        parts[parts.length - 1] += source.slice(params.startIndex, params.endIndex);
    }
    else {
        parts[parts.length - 1] += '()';
    }
    // Return type
    const returnType = node.childForFieldName('return_type');
    if (returnType) {
        parts.push('->');
        parts.push(source.slice(returnType.startIndex, returnType.endIndex));
    }
    // Check if static
    const isStatic = node.children.some(c => c.text === 'static');
    return {
        name,
        doc: extractDocComment(node, source),
        signature: (isStatic ? 'static ' : '') + parts.join(' '),
        isUnsafe: false,
        isAsync: false,
        isPublic: true,
    };
}
/**
 * Parse a variable declaration
 */
function parseVariable(node, source) {
    const name = node.childForFieldName('name')?.text;
    if (!name || !isPublicName(name))
        return null;
    const typeNode = node.childForFieldName('type');
    const annotations = extractAnnotations(node, source);
    // Check for @export
    const isExport = annotations.some(a => a.includes('@export'));
    let type = 'Variant';
    if (typeNode) {
        type = source.slice(typeNode.startIndex, typeNode.endIndex);
    }
    return {
        name,
        type: (isExport ? '@export ' : '') + type,
        doc: extractDocComment(node, source),
        isPublic: true,
    };
}
/**
 * Parse a constant
 */
function parseConstant(node, source) {
    const name = node.childForFieldName('name')?.text;
    if (!name || !isPublicName(name))
        return null;
    const typeNode = node.childForFieldName('type');
    return {
        name,
        doc: extractDocComment(node, source),
        type: typeNode ? source.slice(typeNode.startIndex, typeNode.endIndex) : 'Variant',
        isStatic: true,
    };
}
/**
 * Parse a signal declaration
 */
function parseSignal(node, source) {
    const name = node.childForFieldName('name')?.text;
    if (!name || !isPublicName(name))
        return null;
    const params = node.childForFieldName('parameters');
    let sig = `signal ${name}`;
    if (params) {
        sig += source.slice(params.startIndex, params.endIndex);
    }
    return {
        name,
        doc: extractDocComment(node, source),
        signature: sig,
        isUnsafe: false,
        isAsync: false,
        isPublic: true,
    };
}
/**
 * Parse an enum
 */
function parseEnum(node, source) {
    const name = node.childForFieldName('name')?.text;
    if (!name)
        return null;
    const variants = [];
    const body = node.childForFieldName('body');
    if (body) {
        for (const child of body.namedChildren) {
            if (child.type === 'enumerator') {
                const enumName = child.childForFieldName('name')?.text;
                const value = child.childForFieldName('value');
                if (enumName) {
                    if (value) {
                        variants.push(`${enumName} = ${source.slice(value.startIndex, value.endIndex)}`);
                    }
                    else {
                        variants.push(enumName);
                    }
                }
            }
        }
    }
    return {
        name,
        variants,
        doc: extractDocComment(node, source),
    };
}
/**
 * Parse GDScript source code and extract public interface
 */
export function parseGDScript(source) {
    try {
        const tree = parser.parse(source);
        const summary = {
            purpose: extractClassDoc(tree, source),
            structs: [],
            traits: [],
            enums: [],
            functions: [],
            typeAliases: [],
            constants: [],
            reexports: [],
        };
        // GDScript files represent a single class
        // Look for extends and class_name
        let className = '';
        let extendsClass = '';
        const signals = [];
        const fields = [];
        const methods = [];
        for (const node of tree.rootNode.namedChildren) {
            switch (node.type) {
                case 'class_name_statement': {
                    const nameNode = node.childForFieldName('name');
                    if (nameNode) {
                        className = nameNode.text;
                    }
                    break;
                }
                case 'extends_statement': {
                    const baseNode = node.namedChildren[0];
                    if (baseNode) {
                        extendsClass = source.slice(baseNode.startIndex, baseNode.endIndex);
                    }
                    break;
                }
                case 'function_definition': {
                    const fn = parseFunctionSignature(node, source);
                    if (fn) {
                        const annotations = extractAnnotations(node, source);
                        if (annotations.length > 0) {
                            fn.signature = annotations.join('\n') + '\n' + fn.signature;
                        }
                        methods.push(fn);
                    }
                    break;
                }
                case 'variable_statement': {
                    const field = parseVariable(node, source);
                    if (field)
                        fields.push(field);
                    break;
                }
                case 'const_statement': {
                    const constant = parseConstant(node, source);
                    if (constant)
                        summary.constants.push(constant);
                    break;
                }
                case 'signal_statement': {
                    const signal = parseSignal(node, source);
                    if (signal)
                        signals.push(signal);
                    break;
                }
                case 'enum_definition': {
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
                    break;
                }
                case 'class_definition': {
                    // Inner class
                    const innerName = node.childForFieldName('name')?.text;
                    if (innerName && isPublicName(innerName)) {
                        const innerMethods = [];
                        const innerFields = [];
                        const body = node.childForFieldName('body');
                        if (body) {
                            for (const child of body.namedChildren) {
                                if (child.type === 'function_definition') {
                                    const fn = parseFunctionSignature(child, source);
                                    if (fn)
                                        innerMethods.push(fn);
                                }
                                else if (child.type === 'variable_statement') {
                                    const field = parseVariable(child, source);
                                    if (field)
                                        innerFields.push(field);
                                }
                            }
                        }
                        summary.structs.push({
                            name: innerName,
                            doc: extractDocComment(node, source),
                            generics: '',
                            fields: innerFields,
                            methods: innerMethods,
                            derives: ['inner class'],
                        });
                    }
                    break;
                }
            }
        }
        // Create the main class entry
        if (className || extendsClass || fields.length > 0 || methods.length > 0 || signals.length > 0) {
            const mainClass = {
                name: className || '(script)',
                doc: summary.purpose,
                generics: extendsClass ? `extends ${extendsClass}` : '',
                fields,
                methods: [...signals, ...methods],
                derives: [],
            };
            summary.structs.unshift(mainClass);
            summary.purpose = undefined; // Already in class doc
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
 * Format a summary into human-readable GDScript-style text
 */
function formatSummary(summary) {
    const lines = [];
    // Constants
    for (const constant of summary.constants) {
        if (constant.doc) {
            lines.push(`## ${constant.doc.split('\n')[0]}`);
        }
        lines.push(`const ${constant.name}: ${constant.type}`);
    }
    if (summary.constants.length > 0)
        lines.push('');
    // Enums
    for (const enumDef of summary.enums) {
        if (enumDef.doc) {
            lines.push(`## ${enumDef.doc.split('\n')[0]}`);
        }
        lines.push(`enum ${enumDef.name} {`);
        for (const variant of enumDef.variants) {
            lines.push(`    ${variant},`);
        }
        lines.push('}');
        lines.push('');
    }
    // Classes
    for (const cls of summary.structs) {
        if (cls.doc) {
            lines.push(`## ${cls.doc.split('\n')[0]}`);
        }
        if (cls.derives.includes('inner class')) {
            lines.push(`class ${cls.name}:`);
        }
        else {
            if (cls.name !== '(script)') {
                lines.push(`class_name ${cls.name}`);
            }
            if (cls.generics) {
                lines.push(cls.generics);
            }
        }
        // Fields
        for (const field of cls.fields) {
            if (field.type.startsWith('@export')) {
                lines.push(`    @export`);
                lines.push(`    var ${field.name}: ${field.type.replace('@export ', '')}`);
            }
            else {
                lines.push(`    var ${field.name}: ${field.type}`);
            }
        }
        // Methods (includes signals)
        for (const method of cls.methods) {
            const sigLines = method.signature.split('\n');
            for (const line of sigLines) {
                lines.push(`    ${line}`);
            }
        }
        lines.push('');
    }
    return lines.join('\n').trim();
}
/**
 * Check if this parser supports the given file extension
 */
export function supportsExtension(ext) {
    return ext === '.gd';
}
//# sourceMappingURL=gdscript.js.map