// Caller-owned interface-contract probe for one fixed interface
// (host-owned, candidate-agnostic):
//
//     bool valid_expire_at(const std::string&)   // global, in handler/expire_at.h
//
// The candidate's header is included and the whole contract is one
// compile-time conversion of the function's address to the caller's
// function-pointer type. No assert() is used, so -DNDEBUG changes nothing,
// and the probe is never linked or executed. Compiler errors ARE the failure
// evidence (run-probe.sh prints them verbatim):
//   * namespace-only slip -> "valid_expire_at has not been declared;
//     did you mean handler::valid_expire_at?"
//   * wrong parameter/return type -> function-pointer conversion error.
#include "handler/expire_at.h"

#include <string>

bool (*const probe_valid_expire_at)(const std::string&) = &::valid_expire_at;
