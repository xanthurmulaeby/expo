// Copyright 2025-present 650 Industries. All rights reserved.

#pragma once

#ifdef __cplusplus

#include <jsi/jsi.h>
#include <react/renderer/core/RawProps.h>

// Accessors for `RawProps`'s private `runtime_` / `value_` / `mode_` members.
//
// React Native keeps these private and only befriends `RawPropsParser`. We need the
// whole-object `jsi::Value` (and its runtime) to decode Expo view props directly from
// the live JSI value on the JavaScript thread, without lowering to `folly::dynamic`
// and without forcing each prop name to be pre-registered with the parser.
//
// This uses the explicit template instantiation trick: explicit instantiation of a
// template is allowed to name otherwise-inaccessible members ([temp.explicit] in the
// C++ standard), so it lets us bind a pointer-to-member to a private member without
// modifying React Native. It is standard-conforming (NOT undefined behavior, unlike
// `#define private public` or hardcoded offsets), and if React Native ever renames or
// retypes these members it fails loudly at compile time rather than silently.
//
// Keep this hack isolated to this header.

namespace expo::rawPropsAccess {

// Each `Accessor` declares a friend function returning the bound pointer-to-member.
// `Stealer` is explicitly instantiated below, which is what populates the friend
// function with the (otherwise private) member pointer.

template<typename PtrType, PtrType Member>
struct Stealer {
  friend PtrType getMember(PtrType *tag) {
    return Member;
  }
};

using ValuePtr = facebook::jsi::Value facebook::react::RawProps::*;
using RuntimePtr = facebook::jsi::Runtime *facebook::react::RawProps::*;
using ModePtr = facebook::react::RawProps::Mode facebook::react::RawProps::*;

// `getMember` is found via ADL on the pointer-to-member type; one overload per member type.
ValuePtr getMember(ValuePtr *);
RuntimePtr getMember(RuntimePtr *);
ModePtr getMember(ModePtr *);

template struct Stealer<ValuePtr, &facebook::react::RawProps::value_>;
template struct Stealer<RuntimePtr, &facebook::react::RawProps::runtime_>;
template struct Stealer<ModePtr, &facebook::react::RawProps::mode_>;

inline ValuePtr valuePtr() {
  return getMember(static_cast<ValuePtr *>(nullptr));
}

inline RuntimePtr runtimePtr() {
  return getMember(static_cast<RuntimePtr *>(nullptr));
}

inline ModePtr modePtr() {
  return getMember(static_cast<ModePtr *>(nullptr));
}

} // namespace expo::rawPropsAccess

namespace expo {

/**
 Returns `true` when the given `RawProps` is backed by a live `jsi::Value`
 (i.e. `Mode::JSI`). Only in that mode is the JSI value safe to read.
 */
inline bool rawPropsIsJSIBacked(const facebook::react::RawProps &rawProps)
{
  return rawProps.*(rawPropsAccess::modePtr()) == facebook::react::RawProps::Mode::JSI;
}

/**
 Returns the `jsi::Runtime` backing the given JSI-mode `RawProps`.
 Must only be called when `rawPropsIsJSIBacked()` is `true`.
 */
inline facebook::jsi::Runtime *rawPropsRuntime(const facebook::react::RawProps &rawProps)
{
  return rawProps.*(rawPropsAccess::runtimePtr());
}

/**
 Returns the whole props object as a `jsi::Value` for a JSI-mode `RawProps`.
 Must only be called when `rawPropsIsJSIBacked()` is `true`, on the JavaScript thread.
 */
inline const facebook::jsi::Value &rawPropsValue(const facebook::react::RawProps &rawProps)
{
  return rawProps.*(rawPropsAccess::valuePtr());
}

} // namespace expo

#endif // __cplusplus
