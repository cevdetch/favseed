// Verbose options are always off. Avoid linking unused stdio into browser WASM.
#include <stdio.h>
#define fprintf(...) ((void)0)
