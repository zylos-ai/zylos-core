#include <stdio.h>
#include <time.h>
#include <unistd.h>
static double now(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return t.tv_sec*1000.0+t.tv_nsec/1e6;}
int main(void){int ms[]={1,2,5,10,15,20,25,25,25,50,50,100};double sum=0; for(int i=0;i<59;i++){int req=i<12?ms[i]:i==58?72:100;struct timespec t={req/1000,(req%1000)*1000000};double start=now();int rc=nanosleep(&t,0);double actual=now()-start;sum+=actual;printf("{\"i\":%d,\"pid\":%d,\"requested_ms\":%d,\"actual_ms\":%.6f,\"rc\":%d}\n",i,getpid(),req,actual,rc);}printf("{\"total_actual_ms\":%.6f}\n",sum);return 0;}
