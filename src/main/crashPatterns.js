// Each pattern is checked against the full launch log. First match wins.
// Add to this list as you run into new crash types.
module.exports = [
  {
    // The loader's bundled ASM is older than the game's class file format.
    // Class file major 65 = Java 21, 66 = 22, 67 = 23, 68 = 24, 69 = 25.
    // This is a loader-vs-Minecraft mismatch, not a Java install problem —
    // no amount of changing your JDK fixes it, because the version being
    // rejected is the one Minecraft itself was compiled with.
    test: /Unsupported class file major version/i,
    suggestion: 'This mod loader is too old for this version of Minecraft — its bundled bytecode library can\'t read the game\'s class files. Nothing on your end is broken. Either the loader hasn\'t shipped support for this Minecraft version yet (wait for an update), or use Fabric instead.',
  },
  {
    test: /OutOfMemoryError/i,
    suggestion: 'Minecraft ran out of memory. Increase the max memory allocation in instance settings (try 6–8GB if your system has it).',
  },
  {
    test: /loader\s*version.*expects|requires\s+fabric\s+loader/i,
    suggestion: 'A mod expects a different Fabric/Forge Loader version than what\'s installed. Update your loader version, or downgrade the mod to a build made for your current loader.',
  },
  {
    test: /Mixin apply failed|MixinApplyError/i,
    suggestion: 'Two mods are conflicting through Mixin injection. Try removing recently-added mods one at a time to find the conflicting pair.',
  },
  {
    test: /UnsupportedClassVersionError/i,
    suggestion: 'This version of Minecraft needs a newer Java runtime than what\'s installed. Install the Java version this Minecraft release requires (1.20.5+ needs Java 21).',
    fixable: 'java',
  },
  {
    test: /Error occurred during initialization of VM|Could not find or load main class|JNI call made without checking|invalid or corrupt jarfile.*java/i,
    suggestion: 'The bundled Java runtime looks corrupted or incomplete, usually from an interrupted download. Re-downloading it fixes this.',
    fixable: 'java',
  },
  {
    test: /Duplicate mod|multiple mods.*same\s*id/i,
    suggestion: 'Two installed mods share the same mod ID — likely the same mod installed twice, once per source. Remove the duplicate from your mods folder.',
  },
  {
    test: /ClassNotFoundException|NoClassDefFoundError/i,
    suggestion: 'A mod is missing one of its required dependency libraries. Check the mod\'s page for a "Dependencies" section and install those too.',
  },
  {
    test: /Failed to download|Connection timed out|ETIMEDOUT/i,
    suggestion: 'A file failed to download during launch, probably a network hiccup. Try launching again — if it keeps happening, check your connection or a firewall blocking the launcher.',
  },
];
