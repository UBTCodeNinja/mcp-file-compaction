import Parser from 'tree-sitter';
import CSharp from 'tree-sitter-c-sharp';
const parser = new Parser();
parser.setLanguage(CSharp);
/**
 * Extract XML doc comment from preceding siblings (/// comments)
 */
function extractDocComment(node, source) {
    const comments = [];
    let sibling = node.previousNamedSibling;
    while (sibling) {
        if (sibling.type === 'comment') {
            const text = source.slice(sibling.startIndex, sibling.endIndex);
            // Check for /// style doc comments
            if (text.startsWith('///')) {
                const content = text.replace(/^\/\/\/\s?/, '');
                comments.unshift(content);
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
    if (comments.length === 0)
        return undefined;
    // Parse XML and extract summary
    const joined = comments.join('\n');
    const summaryMatch = joined.match(/<summary>([\s\S]*?)<\/summary>/);
    if (summaryMatch) {
        return summaryMatch[1].trim().replace(/\s+/g, ' ');
    }
    return joined;
}
/**
 * Check if a node has public visibility
 */
function isPublic(node) {
    for (const child of node.children) {
        if (child.type === 'modifier') {
            if (child.text === 'public')
                return true;
            if (child.text === 'private' || child.text === 'protected' || child.text === 'internal') {
                return false;
            }
        }
    }
    // Default depends on context - interface members are public by default
    return false;
}
/**
 * Get all modifiers for a node
 */
function getModifiers(node) {
    const modifiers = [];
    for (const child of node.children) {
        if (child.type === 'modifier') {
            modifiers.push(child.text);
        }
    }
    return modifiers;
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
 * Parse a method signature
 */
function parseMethodSignature(node, source, forInterface = false) {
    const name = node.childForFieldName('name')?.text;
    if (!name)
        return null;
    if (!forInterface && !isPublic(node))
        return null;
    const modifiers = getModifiers(node);
    const parts = [];
    // Add relevant modifiers
    for (const mod of modifiers) {
        if (['public', 'static', 'virtual', 'override', 'abstract', 'async'].includes(mod)) {
            parts.push(mod);
        }
    }
    // Return type
    const returnType = node.childForFieldName('type') || node.childForFieldName('returns');
    if (returnType) {
        parts.push(source.slice(returnType.startIndex, returnType.endIndex));
    }
    parts.push(name);
    // Generics
    const generics = extractGenerics(node, source);
    if (generics) {
        parts[parts.length - 1] += generics;
    }
    // Parameters
    const params = node.childForFieldName('parameters');
    if (params) {
        parts[parts.length - 1] += source.slice(params.startIndex, params.endIndex);
    }
    return {
        name,
        doc: extractDocComment(node, source),
        signature: parts.join(' '),
        isUnsafe: modifiers.includes('unsafe'),
        isAsync: modifiers.includes('async'),
        isPublic: forInterface || isPublic(node),
    };
}
/**
 * Parse class/struct fields and properties
 */
function parseClassMembers(node, source) {
    const fields = [];
    const methods = [];
    const body = node.childForFieldName('body');
    if (!body)
        return { fields, methods };
    for (const child of body.namedChildren) {
        switch (child.type) {
            case 'field_declaration': {
                if (!isPublic(child))
                    continue;
                const type = child.childForFieldName('type');
                if (!type)
                    continue;
                const typeText = source.slice(type.startIndex, type.endIndex);
                const declaration = child.children.find(c => c.type === 'variable_declaration');
                if (declaration) {
                    for (const declarator of declaration.namedChildren) {
                        if (declarator.type === 'variable_declarator') {
                            const name = declarator.childForFieldName('name')?.text;
                            if (name) {
                                fields.push({
                                    name,
                                    type: typeText,
                                    doc: extractDocComment(child, source),
                                    isPublic: true,
                                });
                            }
                        }
                    }
                }
                break;
            }
            case 'property_declaration': {
                if (!isPublic(child))
                    continue;
                const type = child.childForFieldName('type');
                const name = child.childForFieldName('name')?.text;
                if (name && type) {
                    fields.push({
                        name,
                        type: source.slice(type.startIndex, type.endIndex),
                        doc: extractDocComment(child, source),
                        isPublic: true,
                    });
                }
                break;
            }
            case 'method_declaration': {
                const method = parseMethodSignature(child, source);
                if (method)
                    methods.push(method);
                break;
            }
            case 'constructor_declaration': {
                if (!isPublic(child))
                    continue;
                const name = child.childForFieldName('name')?.text || 'ctor';
                const params = child.childForFieldName('parameters');
                methods.push({
                    name,
                    doc: extractDocComment(child, source),
                    signature: `public ${name}${params ? source.slice(params.startIndex, params.endIndex) : '()'}`,
                    isUnsafe: false,
                    isAsync: false,
                    isPublic: true,
                });
                break;
            }
        }
    }
    return { fields, methods };
}
/**
 * Parse a class declaration
 */
function parseClass(node, source) {
    const name = node.childForFieldName('name')?.text;
    if (!name)
        return null;
    if (!isPublic(node))
        return null;
    let generics = extractGenerics(node, source);
    // Get base types
    const bases = node.childForFieldName('bases');
    if (bases) {
        generics += (generics ? ' ' : '') + ': ' + source.slice(bases.startIndex, bases.endIndex)
            .replace(/^:\s*/, '');
    }
    const { fields, methods } = parseClassMembers(node, source);
    const modifiers = getModifiers(node);
    return {
        name,
        doc: extractDocComment(node, source),
        generics,
        fields,
        methods,
        derives: modifiers.filter(m => ['abstract', 'sealed', 'partial', 'static'].includes(m)),
    };
}
/**
 * Parse a struct declaration
 */
function parseStruct(node, source) {
    const name = node.childForFieldName('name')?.text;
    if (!name)
        return null;
    if (!isPublic(node))
        return null;
    let generics = extractGenerics(node, source);
    const bases = node.childForFieldName('bases');
    if (bases) {
        generics += (generics ? ' ' : '') + ': ' + source.slice(bases.startIndex, bases.endIndex)
            .replace(/^:\s*/, '');
    }
    const { fields, methods } = parseClassMembers(node, source);
    const modifiers = getModifiers(node);
    modifiers.unshift('struct');
    return {
        name,
        doc: extractDocComment(node, source),
        generics,
        fields,
        methods,
        derives: modifiers.filter(m => ['struct', 'readonly', 'ref', 'partial'].includes(m)),
    };
}
/**
 * Parse a record declaration
 */
function parseRecord(node, source) {
    const name = node.childForFieldName('name')?.text;
    if (!name)
        return null;
    if (!isPublic(node))
        return null;
    let generics = extractGenerics(node, source);
    // Records often have primary constructor parameters
    const params = node.childForFieldName('parameters');
    if (params) {
        generics += source.slice(params.startIndex, params.endIndex);
    }
    const bases = node.childForFieldName('bases');
    if (bases) {
        generics += (generics ? ' ' : '') + ': ' + source.slice(bases.startIndex, bases.endIndex)
            .replace(/^:\s*/, '');
    }
    const { fields, methods } = parseClassMembers(node, source);
    return {
        name,
        doc: extractDocComment(node, source),
        generics,
        fields,
        methods,
        derives: ['record'],
    };
}
/**
 * Parse an interface declaration
 */
function parseInterface(node, source) {
    const name = node.childForFieldName('name')?.text;
    if (!name)
        return null;
    if (!isPublic(node))
        return null;
    const methods = [];
    const body = node.childForFieldName('body');
    if (body) {
        for (const child of body.namedChildren) {
            if (child.type === 'method_declaration') {
                const method = parseMethodSignature(child, source, true);
                if (method)
                    methods.push(method);
            }
            else if (child.type === 'property_declaration') {
                const propName = child.childForFieldName('name')?.text;
                const type = child.childForFieldName('type');
                if (propName && type) {
                    methods.push({
                        name: propName,
                        doc: extractDocComment(child, source),
                        signature: `${source.slice(type.startIndex, type.endIndex)} ${propName} { get; set; }`,
                        isUnsafe: false,
                        isAsync: false,
                        isPublic: true,
                    });
                }
            }
        }
    }
    // Get base interfaces
    let bounds = '';
    const bases = node.childForFieldName('bases');
    if (bases) {
        bounds = source.slice(bases.startIndex, bases.endIndex).replace(/^:\s*/, '');
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
 * Parse an enum declaration
 */
function parseEnum(node, source) {
    const name = node.childForFieldName('name')?.text;
    if (!name)
        return null;
    if (!isPublic(node))
        return null;
    const variants = [];
    const body = node.childForFieldName('body');
    if (body) {
        for (const child of body.namedChildren) {
            if (child.type === 'enum_member_declaration') {
                const memberName = child.childForFieldName('name')?.text;
                const value = child.childForFieldName('value');
                if (memberName) {
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
        doc: extractDocComment(node, source),
        generics: '',
        variants,
        derives: [],
    };
}
/**
 * Parse a delegate declaration
 */
function parseDelegate(node, source) {
    if (!isPublic(node))
        return null;
    const name = node.childForFieldName('name')?.text;
    const returnType = node.childForFieldName('type');
    const params = node.childForFieldName('parameters');
    if (!name)
        return null;
    let definition = 'delegate ';
    if (returnType) {
        definition += source.slice(returnType.startIndex, returnType.endIndex) + ' ';
    }
    definition += name;
    const generics = extractGenerics(node, source);
    if (generics)
        definition += generics;
    if (params) {
        definition += source.slice(params.startIndex, params.endIndex);
    }
    return {
        name,
        doc: extractDocComment(node, source),
        definition,
    };
}
/**
 * Parse C# source code and extract public interface
 */
export function parseCSharp(source) {
    try {
        const tree = parser.parse(source);
        const summary = {
            purpose: undefined,
            structs: [],
            traits: [],
            enums: [],
            functions: [],
            typeAliases: [],
            constants: [],
            reexports: [],
        };
        function processNode(node) {
            switch (node.type) {
                case 'class_declaration': {
                    const cls = parseClass(node, source);
                    if (cls)
                        summary.structs.push(cls);
                    break;
                }
                case 'struct_declaration': {
                    const struct = parseStruct(node, source);
                    if (struct)
                        summary.structs.push(struct);
                    break;
                }
                case 'record_declaration': {
                    const record = parseRecord(node, source);
                    if (record)
                        summary.structs.push(record);
                    break;
                }
                case 'interface_declaration': {
                    const iface = parseInterface(node, source);
                    if (iface)
                        summary.traits.push(iface);
                    break;
                }
                case 'enum_declaration': {
                    const enumDef = parseEnum(node, source);
                    if (enumDef)
                        summary.enums.push(enumDef);
                    break;
                }
                case 'delegate_declaration': {
                    const delegate = parseDelegate(node, source);
                    if (delegate)
                        summary.typeAliases.push(delegate);
                    break;
                }
                case 'namespace_declaration':
                case 'file_scoped_namespace_declaration': {
                    const nameNode = node.childForFieldName('name');
                    if (nameNode) {
                        summary.reexports.push(`namespace ${source.slice(nameNode.startIndex, nameNode.endIndex)}`);
                    }
                    // Process children
                    const body = node.childForFieldName('body');
                    if (body) {
                        for (const child of body.namedChildren) {
                            processNode(child);
                        }
                    }
                    else {
                        // File-scoped namespace
                        for (const child of node.namedChildren) {
                            processNode(child);
                        }
                    }
                    break;
                }
                case 'using_directive': {
                    summary.reexports.push(source.slice(node.startIndex, node.endIndex));
                    break;
                }
                default: {
                    // Recurse into children
                    for (const child of node.namedChildren) {
                        processNode(child);
                    }
                }
            }
        }
        // Look for file-level doc comment
        const firstChild = tree.rootNode.namedChildren[0];
        if (firstChild?.type === 'comment') {
            const text = source.slice(firstChild.startIndex, firstChild.endIndex);
            if (text.startsWith('///')) {
                summary.purpose = extractDocComment(tree.rootNode.namedChildren[1], source) ||
                    text.replace(/^\/\/\/\s?/gm, '').trim();
            }
        }
        processNode(tree.rootNode);
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
 * Format a summary into human-readable C#-style text
 */
function formatSummary(summary) {
    const lines = [];
    // Using directives
    const usings = summary.reexports.filter(r => r.startsWith('using'));
    for (const using of usings) {
        lines.push(using);
    }
    if (usings.length > 0)
        lines.push('');
    // Namespace
    const namespace = summary.reexports.find(r => r.startsWith('namespace'));
    if (namespace) {
        lines.push(namespace + ';');
        lines.push('');
    }
    // Enums
    for (const enumDef of summary.enums) {
        if (enumDef.doc) {
            lines.push(`/// <summary>${enumDef.doc}</summary>`);
        }
        lines.push(`public enum ${enumDef.name} {`);
        for (const variant of enumDef.variants) {
            lines.push(`    ${variant},`);
        }
        lines.push('}');
        lines.push('');
    }
    // Delegates (type aliases)
    for (const alias of summary.typeAliases) {
        if (alias.doc) {
            lines.push(`/// <summary>${alias.doc}</summary>`);
        }
        lines.push(`public ${alias.definition};`);
    }
    if (summary.typeAliases.length > 0)
        lines.push('');
    // Interfaces
    for (const iface of summary.traits) {
        if (iface.doc) {
            lines.push(`/// <summary>${iface.doc}</summary>`);
        }
        let header = `public interface ${iface.name}${iface.generics}`;
        if (iface.bounds) {
            header += ` : ${iface.bounds}`;
        }
        lines.push(`${header} {`);
        for (const method of iface.methods) {
            lines.push(`    ${method.signature};`);
        }
        lines.push('}');
        lines.push('');
    }
    // Classes/Structs/Records
    for (const cls of summary.structs) {
        if (cls.doc) {
            lines.push(`/// <summary>${cls.doc}</summary>`);
        }
        let header = 'public ';
        if (cls.derives.length > 0) {
            header += cls.derives.join(' ') + ' ';
        }
        if (!cls.derives.includes('struct') && !cls.derives.includes('record')) {
            header += 'class ';
        }
        header += cls.name;
        if (cls.generics) {
            header += cls.generics;
        }
        lines.push(`${header} {`);
        // Fields/Properties
        for (const field of cls.fields) {
            lines.push(`    public ${field.type} ${field.name} { get; set; }`);
        }
        // Methods
        for (const method of cls.methods) {
            lines.push(`    ${method.signature};`);
        }
        lines.push('}');
        lines.push('');
    }
    return lines.join('\n').trim();
}
/**
 * Check if this parser supports the given file extension
 */
export function supportsExtension(ext) {
    return ext === '.cs';
}
//# sourceMappingURL=csharp.js.map