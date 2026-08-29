# Add gzip response compression for large audit results (#997)

This PR enables gzip/deflate compression for audit responses exceeding the 1024-byte threshold. It automatically respects `Accept-Encoding` via the `compression` Express middleware. Small responses below the threshold remain uncompressed.

## Test Output

```
PASS src/audit/router.compression.test.ts
  Audit Router - Gzip Compression
    √ compresses responses larger than the threshold when Accept-Encoding is gzip (41 ms)
    √ does not compress responses smaller than the threshold (6 ms)
    √ does not compress when Accept-Encoding is not provided (6 ms)

Test Suites: 1 passed, 1 total
Tests:       3 passed, 3 total
Snapshots:   0 total
Time:        4.847 s, estimated 5 s
Ran all test suites matching /src\\audit\\router.compression.test.ts/i.
```
