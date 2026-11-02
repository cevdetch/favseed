// Favseed's small ABI; the compressor source is unmodified Google Zopfli.
#include <stdlib.h>
#include <stdint.h>
#include "zopfli.h"

static unsigned char *result;
static size_t length;

void *allocate(size_t size) { return malloc(size); }
void deallocate(void *ptr) { free(ptr); }
void *compress_zlib(const unsigned char *input, size_t size, int iterations) {
  free(result); result = NULL; length = 0;
  ZopfliOptions options;
  ZopfliInitOptions(&options);
  options.numiterations = iterations;
  ZopfliCompress(&options, ZOPFLI_FORMAT_ZLIB, input, size, &result, &length);
  return result;
}
size_t result_size(void) { return length; }
void clear_result(void) { free(result); result = NULL; length = 0; }
