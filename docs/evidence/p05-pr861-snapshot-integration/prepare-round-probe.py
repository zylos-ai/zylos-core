from pathlib import Path
import shutil,sys
source=Path(sys.argv[1]).resolve();target=Path(sys.argv[2]).resolve();target.mkdir(parents=True,exist_ok=False)
for name in ['cli','skills','test','scripts']:
 shutil.copytree(source/name,target/name,symlinks=True)
for name in ['package.json','package-lock.json']:shutil.copy2(source/name,target/name)
(target/'node_modules').symlink_to((source/'node_modules').resolve(),target_is_directory=True)
shutil.copy2(Path(__file__).with_name('round-probe.test.js'),target/'skills/activity-monitor/scripts/__tests__/round-probe.test.js')
print(target)
