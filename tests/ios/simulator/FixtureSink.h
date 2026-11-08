#import <Cordova/CDVCommandDelegate.h>
#import <Cordova/CDVPluginResult.h>

NS_ASSUME_NONNULL_BEGIN

@interface FixtureSink : NSObject <CDVCommandDelegate>
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSMutableArray<CDVPluginResult *> *> *results;
@property(nonatomic, copy, nullable) NSURL *(^urlTransformer)(NSURL *);
// Called synchronously on main, after recording. May clear itself and reenter the sink.
@property(nonatomic, copy, nullable) void (^resultObserver)(NSString *callback, CDVPluginResult *result);
@end

NS_ASSUME_NONNULL_END
