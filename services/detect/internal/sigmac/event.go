package sigmac

// Event is the flat, path-keyed representation both the reference
// interpreter (interpret.go) and the code generator's emitted predicates
// (codegen.go) evaluate a rule against — a plain alias, not a defined
// type, so generated code can use map[string]string directly with no
// import of this package at all. Keys are OCSF paths exactly as
// fieldmap.go produces them ("metadata.operation", "unmapped.UserId",
// "class_uid", ...); turning a real go/sentinelconnector/ocsf.Event into
// this shape is a later ticket's job (P2-04's in-stream worker), not
// this one's — P2-02 only needs to prove the generated code and the
// interpreter agree on SOME event, and fixtures already speak this flat
// shape directly.
type Event = map[string]string
