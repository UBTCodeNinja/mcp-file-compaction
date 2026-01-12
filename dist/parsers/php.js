import Parser from 'tree-sitter';
import PHP from 'tree-sitter-php';
const parser = new Parser();
// tree-sitter-php exports php and php_only - we want the standard PHP grammar
const phpLang = PHP.php || PHP;
parser.setLanguage(phpLang);
/**
 * Extract PHPDoc comment from preceding siblings
 */
function extractDocComment(node, source) {
    let sibling = node.previousNamedSibling;
    while (sibling) {
        if (sibling.type === 'comment') {
            const text = source.slice(sibling.startIndex, sibling.endIndex);
            // Check for PHPDoc style /** ... */
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
 * Check if a node has public visibility (or no visibility modifier which defaults to public in PHP)
 */
function isPublic(node) {
    for (const child of node.children) {
        if (child.type === 'visibility_modifier') {
            return child.text === 'public';
        }
    }
    // Default is public for class members in some contexts
    return true;
}
/**
 * Get visibility text
 */
function getVisibility(node) {
    for (const child of node.children) {
        if (child.type === 'visibility_modifier') {
            return child.text;
        }
    }
    return 'public';
}
/**
 * Check if function/method is static
 */
function isStatic(node) {
    for (const child of node.children) {
        if (child.type === 'static_modifier' || child.text === 'static') {
            return true;
        }
    }
    return false;
}
/**
 * Parse a function signature
 */
function parseFunctionSignature(node, source, isMethod = false) {
    const name = node.childForFieldName('name')?.text;
    if (!name)
        return null;
    const parts = [];
    if (isMethod) {
        parts.push(getVisibility(node));
        if (isStatic(node)) {
            parts.push('static');
        }
    }
    parts.push('function');
    parts.push(name);
    const params = node.childForFieldName('parameters');
    if (params) {
        parts[parts.length - 1] += source.slice(params.startIndex, params.endIndex);
    }
    else {
        parts[parts.length - 1] += '()';
    }
    const returnType = node.childForFieldName('return_type');
    if (returnType) {
        parts.push(':');
        parts.push(source.slice(returnType.startIndex, returnType.endIndex));
    }
    return {
        name,
        doc: extractDocComment(node, source),
        signature: parts.join(' '),
        isUnsafe: false,
        isAsync: false,
        isPublic: !isMethod || isPublic(node),
    };
}
/**
 * Parse class properties
 */
function parseClassProperties(node, source) {
    const fields = [];
    const body = node.childForFieldName('body');
    if (!body)
        return fields;
    for (const child of body.namedChildren) {
        if (child.type === 'property_declaration') {
            if (!isPublic(child))
                continue;
            // Property declaration can have multiple property elements
            for (const propChild of child.namedChildren) {
                if (propChild.type === 'property_element') {
                    const varNode = propChild.namedChildren.find(c => c.type === 'variable_name');
                    if (varNode) {
                        const name = varNode.text.replace(/^\$/, '');
                        const typeNode = child.children.find(c => c.type === 'type' || c.type === 'union_type' || c.type === 'named_type');
                        fields.push({
                            name,
                            type: typeNode ? source.slice(typeNode.startIndex, typeNode.endIndex) : 'mixed',
                            doc: extractDocComment(child, source),
                            isPublic: true,
                        });
                    }
                }
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
        if (child.type === 'method_declaration') {
            if (!isPublic(child))
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
    let generics = '';
    const baseClause = node.children.find(c => c.type === 'base_clause');
    if (baseClause) {
        generics += 'extends ' + source.slice(baseClause.startIndex, baseClause.endIndex)
            .replace(/^extends\s*/, '');
    }
    const implementsClause = node.children.find(c => c.type === 'class_interface_clause');
    if (implementsClause) {
        if (generics)
            generics += ' ';
        generics += source.slice(implementsClause.startIndex, implementsClause.endIndex);
    }
    // Get class modifiers (abstract, final)
    const modifiers = [];
    for (const child of node.children) {
        if (child.type === 'abstract_modifier')
            modifiers.push('abstract');
        if (child.type === 'final_modifier')
            modifiers.push('final');
    }
    return {
        name,
        doc: extractDocComment(node, source),
        generics,
        fields: parseClassProperties(node, source),
        methods: parseClassMethods(node, source),
        derives: modifiers,
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
            if (child.type === 'method_declaration') {
                const fn = parseFunctionSignature(child, source, true);
                if (fn)
                    methods.push(fn);
            }
        }
    }
    // Get extends
    let bounds = '';
    const baseClause = node.children.find(c => c.type === 'base_clause');
    if (baseClause) {
        bounds = source.slice(baseClause.startIndex, baseClause.endIndex)
            .replace(/^extends\s*/, '');
    }
    return {
        name,
        doc: extractDocComment(node, source),
        generics: '',
        bounds,
        methods,
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
    const body = node.childForFieldName('body');
    if (body) {
        for (const child of body.namedChildren) {
            if (child.type === 'method_declaration') {
                if (!isPublic(child))
                    continue;
                const fn = parseFunctionSignature(child, source, true);
                if (fn)
                    methods.push(fn);
            }
        }
    }
    return {
        name,
        doc: extractDocComment(node, source),
        generics: '',
        bounds: '',
        methods,
    };
}
/**
 * Parse a constant definition
 */
function parseConstant(node, source) {
    // Handle both const_declaration and const_element
    const constElement = node.type === 'const_element' ? node :
        node.namedChildren.find(c => c.type === 'const_element');
    if (!constElement)
        return null;
    const name = constElement.childForFieldName('name')?.text;
    if (!name)
        return null;
    // Get type if present
    const typeNode = node.children.find(c => c.type === 'type' || c.type === 'union_type' || c.type === 'named_type');
    return {
        name,
        doc: extractDocComment(node, source),
        type: typeNode ? source.slice(typeNode.startIndex, typeNode.endIndex) : 'mixed',
        isStatic: false,
    };
}
/**
 * Parse PHP source code and extract public interface
 */
export function parsePHP(source) {
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
        // Find the program node (PHP files have a structure: program -> text/php_tag/etc)
        let rootNode = tree.rootNode;
        // Look for file-level doc comment
        const firstChild = rootNode.namedChildren[0];
        if (firstChild?.type === 'comment') {
            const text = source.slice(firstChild.startIndex, firstChild.endIndex);
            if (text.startsWith('/**')) {
                summary.purpose = text
                    .replace(/^\/\*\*\s?/, '')
                    .replace(/\*\/$/, '')
                    .split('\n')
                    .map(line => line.replace(/^\s*\*\s?/, ''))
                    .join('\n')
                    .trim();
            }
        }
        function processNode(node) {
            switch (node.type) {
                case 'class_declaration': {
                    const cls = parseClass(node, source);
                    if (cls)
                        summary.structs.push(cls);
                    break;
                }
                case 'interface_declaration': {
                    const iface = parseInterface(node, source);
                    if (iface)
                        summary.traits.push(iface);
                    break;
                }
                case 'trait_declaration': {
                    const trait = parseTrait(node, source);
                    if (trait)
                        summary.traits.push(trait);
                    break;
                }
                case 'enum_declaration': {
                    const name = node.childForFieldName('name')?.text;
                    if (name) {
                        const variants = [];
                        const body = node.childForFieldName('body');
                        if (body) {
                            for (const child of body.namedChildren) {
                                if (child.type === 'enum_case') {
                                    const caseName = child.childForFieldName('name')?.text;
                                    if (caseName)
                                        variants.push(caseName);
                                }
                            }
                        }
                        summary.enums.push({
                            name,
                            doc: extractDocComment(node, source),
                            generics: '',
                            variants,
                            derives: [],
                        });
                    }
                    break;
                }
                case 'function_definition': {
                    const fn = parseFunctionSignature(node, source);
                    if (fn)
                        summary.functions.push(fn);
                    break;
                }
                case 'const_declaration': {
                    const constant = parseConstant(node, source);
                    if (constant)
                        summary.constants.push(constant);
                    break;
                }
                case 'namespace_definition': {
                    // Record namespace as a re-export style marker
                    const nameNode = node.childForFieldName('name');
                    if (nameNode) {
                        summary.reexports.push(`namespace ${source.slice(nameNode.startIndex, nameNode.endIndex)};`);
                    }
                    // Process children in namespace
                    const body = node.childForFieldName('body');
                    if (body) {
                        for (const child of body.namedChildren) {
                            processNode(child);
                        }
                    }
                    break;
                }
                case 'namespace_use_declaration': {
                    summary.reexports.push(source.slice(node.startIndex, node.endIndex));
                    break;
                }
                default: {
                    // Process children for compound statements
                    for (const child of node.namedChildren) {
                        processNode(child);
                    }
                }
            }
        }
        processNode(rootNode);
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
 * Format a summary into human-readable PHP-style text
 */
function formatSummary(summary) {
    const lines = ['<?php'];
    // File doc
    if (summary.purpose) {
        lines.push('/**');
        for (const line of summary.purpose.split('\n')) {
            lines.push(` * ${line}`);
        }
        lines.push(' */');
        lines.push('');
    }
    // Namespace/use statements
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
        lines.push(`const ${constant.name}: ${constant.type};`);
    }
    if (summary.constants.length > 0)
        lines.push('');
    // Enums
    for (const enumDef of summary.enums) {
        if (enumDef.doc) {
            lines.push(`/** ${enumDef.doc.split('\n')[0]} */`);
        }
        lines.push(`enum ${enumDef.name} {`);
        for (const variant of enumDef.variants) {
            lines.push(`    case ${variant};`);
        }
        lines.push('}');
        lines.push('');
    }
    // Interfaces
    for (const iface of summary.traits) {
        if (iface.doc) {
            lines.push(`/** ${iface.doc.split('\n')[0]} */`);
        }
        let header = `interface ${iface.name}`;
        if (iface.bounds) {
            header += ` extends ${iface.bounds}`;
        }
        lines.push(`${header} {`);
        for (const method of iface.methods) {
            lines.push(`    ${method.signature};`);
        }
        lines.push('}');
        lines.push('');
    }
    // Classes
    for (const cls of summary.structs) {
        if (cls.doc) {
            lines.push(`/** ${cls.doc.split('\n')[0]} */`);
        }
        let header = '';
        if (cls.derives.length > 0) {
            header += cls.derives.join(' ') + ' ';
        }
        header += `class ${cls.name}`;
        if (cls.generics) {
            header += ` ${cls.generics}`;
        }
        lines.push(`${header} {`);
        // Fields
        for (const field of cls.fields) {
            lines.push(`    public ${field.type} $${field.name};`);
        }
        // Methods
        for (const method of cls.methods) {
            lines.push(`    ${method.signature};`);
        }
        lines.push('}');
        lines.push('');
    }
    // Functions
    for (const fn of summary.functions) {
        if (fn.doc) {
            lines.push(`/** ${fn.doc.split('\n')[0]} */`);
        }
        lines.push(`${fn.signature};`);
    }
    return lines.join('\n').trim();
}
/**
 * Check if this parser supports the given file extension
 */
export function supportsExtension(ext) {
    return ext === '.php';
}
//# sourceMappingURL=php.js.map