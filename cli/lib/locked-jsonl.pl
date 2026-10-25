use strict;
use warnings;
use Fcntl qw(:DEFAULT :flock SEEK_END);
my ($operation,$file,$stamp,$limit)=@ARGV;
defined($file) or die "missing log path\n";
my $line='';
if ($operation eq 'append') { local $/; $line=<STDIN>; defined($line) && $line =~ /\n\z/ or die "incomplete log line\n"; }
while (1) {
  sysopen(my $fh,$file,O_WRONLY|O_APPEND|O_CREAT,0600) or die "open: $!\n";
  flock($fh,LOCK_EX) or die "lock: $!\n";
  my @opened=stat($fh); my @current=stat($file);
  if (!@current || $opened[0]!=$current[0] || $opened[1]!=$current[1]) { close($fh); next; }
  if ($operation eq 'append') {
    my $length=$opened[7]; my $offset=0;
    eval {
      while ($offset<length($line)) {
        my $written=syswrite($fh,$line,length($line)-$offset,$offset);
        defined($written) && $written>0 or die "write: $!\n";
        $offset+=$written;
      }
    };
    if ($@) { my $error=$@; truncate($fh,$length) or $error.="truncate: $!\n"; close($fh); die $error; }
  } elsif ($operation eq 'rotate') {
    if ($opened[7]>$limit) {
      my $destination=$file; $destination =~ s/\.jsonl$//;
      $destination.=".$stamp.jsonl";
      while (-e $destination) { $stamp++; $destination=$file; $destination =~ s/\.jsonl$//; $destination.=".$stamp.jsonl"; }
      rename($file,$destination) or die "rename: $!\n";
      print "$destination\n";
    }
  } else { die "unknown operation\n"; }
  close($fh) or die "close: $!\n";
  last;
}
