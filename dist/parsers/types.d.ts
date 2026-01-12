/**
 * Summary types for parsed file contents.
 * These represent the public interface of a file.
 */
export interface FunctionSummary {
    name: string;
    doc?: string;
    signature: string;
    isUnsafe: boolean;
    isAsync: boolean;
    isPublic: boolean;
}
export interface FieldSummary {
    name: string;
    type: string;
    doc?: string;
    isPublic: boolean;
}
export interface StructSummary {
    name: string;
    doc?: string;
    generics: string;
    fields: FieldSummary[];
    methods: FunctionSummary[];
    derives: string[];
}
export interface TraitSummary {
    name: string;
    doc?: string;
    generics: string;
    bounds: string;
    methods: FunctionSummary[];
}
export interface EnumSummary {
    name: string;
    doc?: string;
    generics: string;
    variants: string[];
    derives: string[];
}
export interface TypeAliasSummary {
    name: string;
    doc?: string;
    definition: string;
}
export interface ConstantSummary {
    name: string;
    doc?: string;
    type: string;
    isStatic: boolean;
}
export interface FileSummary {
    /** Module-level doc comment (//! in Rust) */
    purpose?: string;
    /** Public struct definitions */
    structs: StructSummary[];
    /** Public trait definitions */
    traits: TraitSummary[];
    /** Public enum definitions */
    enums: EnumSummary[];
    /** Standalone public functions */
    functions: FunctionSummary[];
    /** Public type aliases */
    typeAliases: TypeAliasSummary[];
    /** Public constants and statics */
    constants: ConstantSummary[];
    /** Re-exports (pub use ...) */
    reexports: string[];
}
export interface ParseResult {
    success: true;
    summary: FileSummary;
    formattedSummary: string;
}
export interface ParseError {
    success: false;
    error: string;
}
export type ParseOutcome = ParseResult | ParseError;
//# sourceMappingURL=types.d.ts.map