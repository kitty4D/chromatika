# keep bouncy castle (used for keccak256 + ed25519)
-keep class org.bouncycastle.** { *; }
-dontwarn org.bouncycastle.**

# keep kotlinx-serialization metadata
-keepattributes *Annotation*, InnerClasses
-dontwarn kotlinx.serialization.**
-keep,includedescriptorclasses class xyz.chromatika.seeker.**$$serializer { *; }
-keepclassmembers class xyz.chromatika.seeker.** {
    *** Companion;
}
-keepclasseswithmembers class xyz.chromatika.seeker.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# keep solana mobile entry points
-keep class com.solanamobile.** { *; }
-keep class com.solana.** { *; }
