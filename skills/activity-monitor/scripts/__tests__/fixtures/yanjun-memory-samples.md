# Memory Sample Provenance

Numeric F17 samples supplied by Luna for the memory-capacity regression test.
The source archive has 7,174 rows in three files. This fixture retains 5,652
rows in `1794569462245 - 7 days < ts <= 1794569462245`, sorted by timestamp.
Only `v` changes from 1 to 2; all other fields retain their source values.
These historical values still include active file cache, as required by the
specified replay. They are not measurements of the new memory reader.

Source SHA256 values:

- `yanjun-pool-memory-samples.1794555393335.jsonl`: `22a304aead4a0dcc036fd88a9942423ccb4868823b055ca70b14250201ce6fae`
- `yanjun-pool-memory-samples.1794468986115.jsonl`: `a9dc2336d1ae84a879353dad8493e875ce5ed48f28d5d791290ca35e6327fe05`
- `yanjun-pool-memory-samples.jsonl`: `5c650170fbdb52d2a0812a0634fcf2f6872134cd5fc83537e83c52a87baa2e90`
