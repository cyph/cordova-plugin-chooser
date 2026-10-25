#import "FixtureSink.h"
#if __has_include(<Cordova/CDVSettingsDictionary.h>)
#import <Cordova/CDVSettingsDictionary.h>
#endif

@implementation FixtureSink
- (instancetype)init { if ((self = [super init])) { self.results = [NSMutableDictionary new]; } return self; }
#if __has_include(<Cordova/CDVSettingsDictionary.h>)
- (CDVSettingsDictionary *)settings { return [[CDVSettingsDictionary alloc] initWithDictionary:@{}]; }
#else
- (NSDictionary *)settings { return @{}; }
#endif
- (NSString *)pathForResource:(NSString *)path { return nil; }
- (id)getCommandInstance:(NSString *)name { return nil; }
- (void)sendPluginResult:(CDVPluginResult *)result callbackId:(NSString *)callback {
    NSAssert([NSThread isMainThread], @"Callbacks must return on the main thread");
    if (!self.results[callback]) self.results[callback] = [NSMutableArray new];
    [self.results[callback] addObject:result];
}
- (void)evalJs:(NSString *)js {}
- (void)evalJs:(NSString *)js scheduledOnRunLoop:(BOOL)scheduled {}
- (void)runInBackground:(void (^)(void))block { dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), block); }
@end
