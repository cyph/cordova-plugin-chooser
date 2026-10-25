#import <Cordova/CDVCommandDelegate.h>
#import <Cordova/CDVPluginResult.h>

@interface FixtureSink : NSObject <CDVCommandDelegate>
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSMutableArray<CDVPluginResult *> *> *results;
@property(nonatomic, copy) UrlTransformerBlock urlTransformer;
@end
