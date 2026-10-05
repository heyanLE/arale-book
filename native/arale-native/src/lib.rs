//! Reusable archive extraction for the Rust desktop host; no sidecar process required.
pub mod archive;
pub mod extract;
pub mod format;
pub mod out;
pub mod pages;
pub mod paths;

#[cfg(test)]
mod testsupport;
