import org.gradle.api.attributes.AttributeDisambiguationRule
import org.gradle.api.attributes.MultipleCandidatesDetails
import org.gradle.api.artifacts.type.ArtifactTypeDefinition

// Dependency auditing has no AGP task-specific artifact view. Prefer the ordinary
// jar when a project publishes several secondary artifacts; explicit AGP views
// still select their requested artifact type.
abstract class PreferJar : AttributeDisambiguationRule<String> {
    override fun execute(details: MultipleCandidatesDetails<String>) {
        if (details.consumerValue == null && "jar" in details.candidateValues) {
            details.closestMatch("jar")
        }
    }
}
dependencies.attributesSchema.attribute(ArtifactTypeDefinition.ARTIFACT_TYPE_ATTRIBUTE) {
    disambiguationRules.add(PreferJar::class.java)
}
