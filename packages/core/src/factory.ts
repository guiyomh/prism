import * as E from 'fp-ts/lib/Either';
import * as TE from 'fp-ts/lib/TaskEither';
import { pipe } from 'fp-ts/lib/pipeable';
import { defaults } from 'lodash';
import { IPrism, IPrismComponents, IPrismConfig, IPrismDiagnostic, IPrismProxyConfig, IPrismOutput } from './types';
import { sequenceT } from 'fp-ts/lib/Apply';
import { getSemigroup } from 'fp-ts/lib/NonEmptyArray';
import { DiagnosticSeverity } from '@stoplight/types';

const sequenceValidation = sequenceT(E.getValidation(getSemigroup<IPrismDiagnostic>()));

function isProxyConfig(p: IPrismConfig): p is IPrismProxyConfig {
  return !p.mock;
}

function createWarningOutput<Output>(output: Output): IPrismOutput<Output> {
  return {
    output,
    validations: {
      input: [
        {
          message: 'Selected route not found',
          severity: DiagnosticSeverity.Warning,
        },
      ],
      output: [],
    },
  };
}

export function factory<Resource, Input, Output, Config extends IPrismConfig>(
  defaultConfig: Config,
  components: IPrismComponents<Resource, Input, Output, Config>
): IPrism<Resource, Input, Output, Config> {
  type ResourceAndValidation = {
    resource: Resource;
    validations: IPrismDiagnostic[];
  };

  const inputValidation = (
    resource: Resource,
    input: Input,
    config: Config
  ): TE.TaskEither<Error, ResourceAndValidation> =>
    pipe(
      sequenceValidation(
        config.validateRequest ? components.validateInput({ resource, element: input }) : E.right(input),
        config.checkSecurity ? components.validateSecurity({ resource, element: input }) : E.right(input)
      ),
      E.fold(
        validations => validations as IPrismDiagnostic[],
        () => []
      ),
      validations => TE.right({ resource, validations })
    );

  const mockOrForward = (
    resource: Resource,
    input: Input,
    config: Config,
    validations: IPrismDiagnostic[]
  ): TE.TaskEither<Error, ResourceAndValidation & { output: Output }> => {
    const produceOutput = isProxyConfig(config)
      ? components.forward(input, config.upstream.href)(components.logger.child({ name: 'PROXY' }))
      : TE.fromEither(
          components.mock({
            resource,
            input: {
              validations,
              data: input,
            },
            config: config.mock,
          })(components.logger.child({ name: 'NEGOTIATOR' }))
        );

    return pipe(
      produceOutput,
      TE.map(output => ({ output, resource, validations }))
    );
  };

  return {
    request: (input: Input, resources: Resource[], c?: Config) => {
      // build the config for this request
      const config = defaults<unknown, Config>(c, defaultConfig);

      return pipe(
        TE.fromEither(components.route({ resources, input })),
        TE.fold(
          error => {
            if (!config.errors && isProxyConfig(config)) {
              return pipe(
                components.forward(input, config.upstream.href)(components.logger.child({ name: 'PROXY' })),
                TE.map(createWarningOutput)
              );
            } else return TE.left(error);
          },
          resource =>
            pipe(
              inputValidation(resource, input, config),
              TE.chain(({ resource, validations }) => mockOrForward(resource, input, config, validations)),
              TE.map(({ output, resource, validations: inputValidations }) => {
                const outputValidations = config.validateResponse
                  ? pipe(
                      E.swap(components.validateOutput({ resource, element: output })),
                      E.getOrElse<Output, IPrismDiagnostic[]>(() => [])
                    )
                  : [];

                return {
                  output,
                  validations: {
                    input: inputValidations,
                    output: outputValidations,
                  },
                };
              })
            )
        )
      );
    },
  };
}
